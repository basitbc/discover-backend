import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { deleteImage, uploadImage } from '../lib/storage.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';

/**
 * Image uploads for the admin UI.
 *
 * The response is a plain URL string that goes straight into an image column.
 * Images already sitting in the Next app's public/ folder keep their
 * `/Assets/...` paths, so both forms coexist — the column stores one complete
 * path either way and the site renders whatever it is given.
 */

const folderSchema = z.object({
  folder: z
    .enum(['packages', 'destinations', 'blogs', 'testimonials', 'hero', 'general'])
    .default('general'),
});

const deleteBodySchema = z.object({
  url: z.string().url(),
});

export function registerUploadRoutes(app: FastifyInstance): void {
  const auth = { onRequest: [app.authenticate] };

  app.post(
    '/admin/uploads',
    {
      ...auth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['admin:uploads'],
        summary: 'Upload an image and get back its public URL',
        querystring: folderSchema,
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { folder } = request.query as z.infer<typeof folderSchema>;

      const file = await request.file();
      if (!file) throw badRequest('No file was uploaded. Send one file field named "file".');

      const buffer = await file.toBuffer();

      // @fastify/multipart truncates rather than throwing once the configured
      // limit is hit, so an over-size upload must be detected explicitly.
      if (file.file.truncated) {
        const mb = (env.MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(1);
        throw badRequest(`Image is larger than the ${mb} MB limit`);
      }

      const stored = await uploadImage(buffer, file.filename, folder);

      // Every upload becomes a library row, so it is immediately reusable on
      // other records rather than being welded to the one being edited.
      const image = await prisma.image.create({
        data: {
          url: stored.url,
          publicId: stored.pathname,
          provider: env.STORAGE_DRIVER,
          filename: file.filename,
          width: stored.width ?? null,
          height: stored.height ?? null,
          bytes: stored.size,
          format: stored.format ?? null,
          folder,
        },
      });

      request.log.info(
        { imageId: image.id, url: stored.url, size: stored.size, by: request.user.email },
        'Image uploaded',
      );

      return image;
    },
  );

  app.delete(
    '/admin/uploads',
    {
      ...auth,
      schema: {
        tags: ['admin:uploads'],
        summary: 'Delete a previously uploaded image',
        body: deleteBodySchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { url } = request.body as z.infer<typeof deleteBodySchema>;
      const deleted = await deleteImage(url);

      // `false` means the URL was not a Blob asset (most likely an
      // /Assets/... path), which is not an error worth failing the request over.
      return { deleted, url };
    },
  );
}
