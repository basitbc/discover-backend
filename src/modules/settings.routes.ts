import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { stripHtml } from '../lib/sanitize.js';
import { revalidateFrontend } from '../lib/revalidate.js';
import { siteSettingsUpdateSchema } from './content.schemas.js';
import { flattenImageFields } from '../lib/images.js';

/**
 * Site-wide settings — phone number, address, about copy, logo text.
 *
 * A singleton row (id = 1) rather than a table of key/value pairs: the fields
 * are a fixed, known set, so a real schema gives validation and typing for free.
 * Consumed by the Navbar, Footer, Layout and About section on every page, which
 * is why a write here revalidates the whole site.
 */

const SETTINGS_ID = 1;

const DEFAULTS = {
  id: SETTINGS_ID,
  logoText: 'Discover Kashmir',
  phoneNumber: '',
  email: '',
  whatsappNumber: '',
  address: '',
  about1: '',
  about2: '',
};

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings',
    { schema: { tags: ['settings'], summary: 'Get site-wide settings' } },
    async () => {
      const settings = await prisma.siteSettings.findUnique({
        where: { id: SETTINGS_ID },
        include: {
          aboutImageBack: true,
          aboutImageFront: true,
          contactBgImage: true,
          packagesBanner: true,
          destinationsBanner: true,
          blogsBanner: true,
          packagesOverview: true,
          blogSectionBg: true,
          headerLogo: true,
          footerLogo: true,
        },
      });

      // Never 404 here. The site's header and footer read this on every page;
      // returning defaults keeps the frontend renderable on a fresh database.
      if (!settings) return { ...DEFAULTS, updatedAt: null };

      return flattenImageFields(settings as unknown as Record<string, unknown>, [
        'aboutImageBack',
        'aboutImageFront',
        'contactBgImage',
        'packagesBanner',
        'destinationsBanner',
        'blogsBanner',
        'packagesOverview',
        'blogSectionBg',
        'headerLogo',
        'footerLogo',
      ]);
    },
  );

  app.put(
    '/admin/settings',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['admin:settings'],
        summary: 'Update site-wide settings',
        body: siteSettingsUpdateSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const input = request.body as z.infer<typeof siteSettingsUpdateSchema>;

      const data: Record<string, unknown> = { ...input };
      for (const field of ['about1', 'about2', 'address'] as const) {
        if (typeof data[field] === 'string') data[field] = stripHtml(data[field] as string);
      }

      const settings = await prisma.siteSettings.upsert({
        where: { id: SETTINGS_ID },
        update: data,
        create: { ...DEFAULTS, ...data },
        include: {
          aboutImageBack: true,
          aboutImageFront: true,
          contactBgImage: true,
          packagesBanner: true,
          destinationsBanner: true,
          blogsBanner: true,
          packagesOverview: true,
          blogSectionBg: true,
          headerLogo: true,
          footerLogo: true,
        },
      });

      // Settings appear in the header/footer of every page.
      revalidateFrontend(['/', '/packages', '/destinations', '/travelblogs', '/contact'], app.log);

      return settings;
    },
  );
}
