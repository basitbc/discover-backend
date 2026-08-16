import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { conflict, notFound } from '../lib/errors.js';
import { deleteImage } from '../lib/storage.js';

/**
 * Media library.
 *
 * Images are first-class records rather than URL strings on content, so the
 * same photo can be reused across a package, a blog and a hero slide without
 * being uploaded three times — and its alt text is written once.
 *
 * Admin-only: the public site never browses the library, it only receives the
 * URLs already attached to content.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(40),
  q: z.string().trim().min(1).optional(),
  folder: z.string().trim().min(1).optional(),
});

const updateSchema = z.object({
  alt: z.string().trim().max(300).nullish(),
  filename: z.string().trim().min(1).max(200).optional(),
  folder: z.string().trim().min(1).max(60).nullish(),
});

/**
 * Every relation that can point at an Image, for the in-use count.
 *
 * This list is what stops someone deleting a photo that is still on the site,
 * so ANY new Image relation added to schema.prisma must be added here too —
 * otherwise the delete guard silently under-counts and the image can be removed
 * from under a live page.
 */
const USAGE_COUNTS = {
  packageCards: true,
  packageBanners: true,
  destinationCards: true,
  destinationBanners: true,
  destinationThumbs: true,
  blogCards: true,
  blogBanners: true,
  testimonials: true,
  heroSlides: true,
  settingsAboutBack: true,
  settingsAboutFront: true,
  settingsContactBg: true,
  settingsPackagesBanner: true,
  settingsDestinationsBanner: true,
  settingsBlogsBanner: true,
  settingsPackagesOverview: true,
  settingsBlogSectionBg: true,
  settingsHeaderLogo: true,
  settingsFooterLogo: true,
} as const;

function withUsage(row: Record<string, unknown>): Record<string, unknown> {
  const counts = (row._count ?? {}) as Record<string, number>;
  const usageCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const { _count, ...rest } = row;
  return { ...rest, usageCount };
}

export function registerImageRoutes(app: FastifyInstance): void {
  const auth = { onRequest: [app.authenticate] };

  app.get(
    '/admin/images',
    {
      ...auth,
      schema: {
        tags: ['admin:images'],
        summary: 'Browse the media library',
        querystring: listQuery,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { page, perPage, q, folder } = request.query as z.infer<typeof listQuery>;

      const where = {
        ...(folder ? { folder } : {}),
        ...(q
          ? {
              OR: [
                { filename: { contains: q, mode: 'insensitive' as const } },
                { alt: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.image.findMany({
          where,
          // Newest first: the image someone just uploaded is the one they want.
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
          include: { _count: { select: USAGE_COUNTS } },
        }),
        prisma.image.count({ where }),
      ]);

      return {
        items: rows.map((r) => withUsage(r as unknown as Record<string, unknown>)),
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage) || 1,
      };
    },
  );

  /** Distinct folders, for the picker's filter chips. */
  app.get(
    '/admin/images/folders',
    {
      ...auth,
      schema: {
        tags: ['admin:images'],
        summary: 'Folders in use',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await prisma.image.groupBy({
        by: ['folder'],
        _count: { _all: true },
        orderBy: { folder: 'asc' },
      });

      return {
        folders: rows
          .filter((r) => r.folder)
          .map((r) => ({ name: r.folder as string, count: r._count._all })),
      };
    },
  );

  app.get(
    '/admin/images/:id',
    {
      ...auth,
      schema: {
        tags: ['admin:images'],
        summary: 'Get one image',
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const row = await prisma.image.findUnique({
        where: { id },
        include: { _count: { select: USAGE_COUNTS } },
      });
      if (!row) throw notFound('Image');
      return withUsage(row as unknown as Record<string, unknown>);
    },
  );

  /** Editing alt text is the main reason to update an image. */
  app.patch(
    '/admin/images/:id',
    {
      ...auth,
      schema: {
        tags: ['admin:images'],
        summary: 'Update image details (alt text, name, folder)',
        params: idParam,
        body: updateSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      if (!(await prisma.image.findUnique({ where: { id }, select: { id: true } }))) {
        throw notFound('Image');
      }
      return prisma.image.update({
        where: { id },
        data: request.body as z.infer<typeof updateSchema>,
      });
    },
  );

  app.delete(
    '/admin/images/:id',
    {
      ...auth,
      schema: {
        tags: ['admin:images'],
        summary: 'Delete an image from the library and its storage provider',
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;

      const row = await prisma.image.findUnique({
        where: { id },
        include: { _count: { select: USAGE_COUNTS } },
      });
      if (!row) throw notFound('Image');

      const usage = Object.values(row._count as Record<string, number>).reduce(
        (sum, n) => sum + n,
        0,
      );

      // Refuse rather than silently blanking someone's page. The FK is
      // onDelete: SetNull, so deleting WOULD succeed — and quietly remove the
      // photo from every record using it. Making the user unpick it first means
      // that can never happen by accident.
      if (usage > 0) {
        throw conflict(
          `This image is used by ${usage} ${usage === 1 ? 'record' : 'records'}. Remove it from them before deleting.`,
        );
      }

      // Storage first: if that fails we keep the row rather than orphan a file.
      await deleteImage(row.url);
      await prisma.image.delete({ where: { id } });

      return { deleted: true, id };
    },
  );
}
