import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { notFound } from '../lib/errors.js';
import { sanitizeRichText, stripHtml } from '../lib/sanitize.js';
import { revalidateFrontend } from '../lib/revalidate.js';
import {
  LIST_KINDS,
  invalidateGlobalListCache,
} from './package-lists.js';
import {
  replaceListItemsSchema,
  replaceTourPlanSchema,
  listKindSchema,
} from './content.schemas.js';

/**
 * Sub-resources of a package.
 *
 * Both are REPLACE-the-whole-collection operations rather than per-row CRUD.
 * The admin edits a tour plan as one ordered list and clicks save once, so a
 * single atomic replace matches what the user actually did — and removes any
 * chance of the stored order disagreeing with what they saw on screen.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerPackageExtraRoutes(app: FastifyInstance): void {
  const auth = { onRequest: [app.authenticate] };

  // ------------------------------------------------------------ tour plan
  app.put(
    '/admin/packages/:id/tour-plan',
    {
      ...auth,
      schema: {
        tags: ['admin:packages'],
        summary: 'Replace the entire tour plan for a package',
        params: idParam,
        body: replaceTourPlanSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const { items } = request.body as z.infer<typeof replaceTourPlanSchema>;

      const pkg = await prisma.package.findUnique({
        where: { id },
        select: { id: true, slug: true },
      });
      if (!pkg) throw notFound('Package');

      const rows = items.map((item, index) => ({
        packageId: id,
        day: item.day,
        title: item.title,
        // Day descriptions are the rich-text field on a package.
        description: sanitizeRichText(item.description),
        note: item.note ? stripHtml(item.note) : null,
        sortOrder: item.sortOrder ?? index,
      }));

      // Delete-then-insert inside one transaction: either the whole new plan
      // lands or the old one is left untouched.
      await prisma.$transaction([
        prisma.tourPlanDay.deleteMany({ where: { packageId: id } }),
        ...(rows.length > 0 ? [prisma.tourPlanDay.createMany({ data: rows })] : []),
      ]);

      const tourPlan = await prisma.tourPlanDay.findMany({
        where: { packageId: id },
        orderBy: { sortOrder: 'asc' },
      });

      revalidateFrontend(['/packages', `/packages/${pkg.slug}`], app.log);
      return { packageId: id, tourPlan };
    },
  );

  // ----------------------------------------------- per-package list items
  app.put(
    '/admin/packages/:id/list-items',
    {
      ...auth,
      schema: {
        tags: ['admin:packages'],
        summary:
          'Replace one kind of list (inclusions, exclusions, ...) for a package. Send an empty array to fall back to the global defaults.',
        params: idParam,
        body: replaceListItemsSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const { kind, items } = request.body as z.infer<typeof replaceListItemsSchema>;

      const pkg = await prisma.package.findUnique({
        where: { id },
        select: { id: true, slug: true },
      });
      if (!pkg) throw notFound('Package');

      await prisma.$transaction([
        prisma.packageListItem.deleteMany({ where: { packageId: id, kind } }),
        ...(items.length > 0
          ? [
              prisma.packageListItem.createMany({
                data: items.map((text, index) => ({
                  packageId: id,
                  kind,
                  text: stripHtml(text),
                  sortOrder: index,
                })),
              }),
            ]
          : []),
      ]);

      revalidateFrontend(['/packages', `/packages/${pkg.slug}`], app.log);
      return {
        packageId: id,
        kind,
        count: items.length,
        usingGlobalDefaults: items.length === 0,
      };
    },
  );

  // --------------------------------------------------- global defaults
  app.get(
    '/package-defaults',
    {
      schema: {
        tags: ['packages'],
        summary:
          'Global inclusion/exclusion/terms lists applied to any package that does not define its own',
      },
    },
    async () => {
      const rows = await prisma.packageListItem.findMany({
        where: { packageId: null },
        orderBy: { sortOrder: 'asc' },
        select: { kind: true, text: true },
      });

      const lists = Object.fromEntries(
        LIST_KINDS.map((kind) => [
          kind,
          rows.filter((r) => r.kind === kind).map((r) => r.text),
        ]),
      );

      return { lists };
    },
  );

  app.put(
    '/admin/package-defaults',
    {
      ...auth,
      schema: {
        tags: ['admin:packages'],
        summary: 'Replace one kind of the global default lists',
        body: replaceListItemsSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { kind, items } = request.body as z.infer<typeof replaceListItemsSchema>;

      await prisma.$transaction([
        prisma.packageListItem.deleteMany({ where: { packageId: null, kind } }),
        ...(items.length > 0
          ? [
              prisma.packageListItem.createMany({
                data: items.map((text, index) => ({
                  packageId: null,
                  kind,
                  text: stripHtml(text),
                  sortOrder: index,
                })),
              }),
            ]
          : []),
      ]);

      // Defaults are cached for reads; drop it so the change is visible at once.
      invalidateGlobalListCache();
      revalidateFrontend(['/packages'], app.log);

      return { kind, count: items.length };
    },
  );

  // Convenience for the admin UI: the set of valid list kinds.
  app.get(
    '/admin/package-list-kinds',
    {
      ...auth,
      schema: {
        tags: ['admin:packages'],
        summary: 'Valid list kinds',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ kinds: listKindSchema.options }),
  );
}
