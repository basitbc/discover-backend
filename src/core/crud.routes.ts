import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BaseService } from './base.service.js';
import type { Row } from './base.repository.js';
import { revalidateFrontend } from '../lib/revalidate.js';

/**
 * HTTP LAYER.
 *
 * Translates requests into service calls and results into responses. It decides
 * status codes, validates the request shape, and enforces authentication — and
 * nothing else. No query building, no slug logic, no sanitisation.
 *
 * Because every content type exposes the same seven operations, this is written
 * once and configured per resource. Adding a content type is a Prisma model, a
 * zod schema and a config block; fixing a pagination or permission bug here
 * fixes it everywhere at once.
 *
 *   GET    /:resource               public, published only
 *   GET    /:resource/:slug         public                    (when hasSlug)
 *   GET    /admin/:resource         auth, includes drafts
 *   GET    /admin/:resource/:id     auth
 *   POST   /admin/:resource         auth
 *   PATCH  /admin/:resource/:id     auth
 *   DELETE /admin/:resource/:id     auth
 *   POST   /admin/:resource/reorder auth                      (when hasSortOrder)
 */

export interface CrudRouteConfig {
  /** URL segment and Swagger tag, e.g. "packages". */
  resource: string;
  singular: string;
  service: BaseService;

  createSchema: z.ZodType<Record<string, unknown>>;
  updateSchema: z.ZodType<Record<string, unknown>>;

  hasSlug?: boolean;
  hasSortOrder?: boolean;

  /** Frontend paths to rebuild after a write. */
  revalidatePaths?: (row: Row) => string[];
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const slugParam = z.object({ slug: z.string().min(1) });

const listQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(50),
  q: z.string().trim().min(1).optional(),
});

const adminListQuery = listQuery.extend({
  published: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const reorderBody = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        sortOrder: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
});

export function registerCrudRoutes(app: FastifyInstance, config: CrudRouteConfig): void {
  const { resource, singular, service, hasSlug = false, hasSortOrder = false } = config;
  const auth = { onRequest: [app.authenticate] };
  const adminBase = `/admin/${resource}`;

  const revalidate = (row: Row) => {
    if (config.revalidatePaths) revalidateFrontend(config.revalidatePaths(row), app.log);
  };

  // ---------------------------------------------------------------- public

  app.get(
    `/${resource}`,
    { schema: { tags: [resource], summary: `List published ${resource}`, querystring: listQuery } },
    (request) =>
      service.list({
        ...(request.query as z.infer<typeof listQuery>),
        publicOnly: true,
      }),
  );

  if (hasSlug) {
    app.get(
      `/${resource}/:slug`,
      {
        schema: {
          tags: [resource],
          summary: `Get a published ${singular.toLowerCase()} by slug`,
          params: slugParam,
        },
      },
      (request) => service.getBySlug((request.params as z.infer<typeof slugParam>).slug),
    );
  }

  // ----------------------------------------------------------------- admin

  app.get(
    adminBase,
    {
      ...auth,
      schema: {
        tags: [`admin:${resource}`],
        summary: `List all ${resource}, including unpublished`,
        querystring: adminListQuery,
        security: [{ bearerAuth: [] }],
      },
    },
    (request) => service.list(request.query as z.infer<typeof adminListQuery>),
  );

  app.get(
    `${adminBase}/:id`,
    {
      ...auth,
      schema: {
        tags: [`admin:${resource}`],
        summary: `Get one ${singular.toLowerCase()} by id`,
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    (request) => service.getById((request.params as z.infer<typeof idParam>).id),
  );

  app.post(
    adminBase,
    {
      ...auth,
      schema: {
        tags: [`admin:${resource}`],
        summary: `Create a ${singular.toLowerCase()}`,
        body: config.createSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const row = await service.create(request.body as Row);
      revalidate(row);
      return reply.code(201).send(row);
    },
  );

  /**
   * PATCH is the correct verb for a partial update, and PUT is registered
   * alongside it as an alias sharing the same handler and schema.
   *
   * The alias is not academic. Corporate proxies, security appliances and some
   * browser extensions still treat PATCH as unrecognised and drop it — the
   * request never reaches the server, and the browser reports it as a CORS
   * failure ("Method PATCH is not allowed by Access-Control-Allow-Methods")
   * even though the API answers that preflight correctly. PUT traverses those
   * middleboxes, so the admin has a route that works on networks where PATCH
   * does not. Both apply the same partial-update semantics: absent fields are
   * left untouched.
   */
  app.route({
    method: ['PATCH', 'PUT'],
    url: `${adminBase}/:id`,
    ...auth,
    schema: {
      tags: [`admin:${resource}`],
      summary: `Update a ${singular.toLowerCase()}`,
      params: idParam,
      body: config.updateSchema,
      security: [{ bearerAuth: [] }],
    },
    handler: async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const row = await service.update(id, request.body as Row);
      revalidate(row);
      return row;
    },
  });

  app.delete(
    `${adminBase}/:id`,
    {
      ...auth,
      schema: {
        tags: [`admin:${resource}`],
        summary: `Delete a ${singular.toLowerCase()}`,
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const removed = await service.remove(id);
      revalidate(removed);
      return { deleted: true, id };
    },
  );

  if (hasSortOrder) {
    app.post(
      `${adminBase}/reorder`,
      {
        ...auth,
        schema: {
          tags: [`admin:${resource}`],
          summary: `Reorder ${resource}`,
          body: reorderBody,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => {
        const { items } = request.body as z.infer<typeof reorderBody>;
        const reordered = await service.reorder(items);
        revalidate({});
        return { reordered };
      },
    );
  }
}
