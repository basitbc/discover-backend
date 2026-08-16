import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { BaseRepository, type PrismaDelegate } from '../core/base.repository.js';
import { BaseService } from '../core/base.service.js';
import { registerCrudRoutes } from '../core/crud.routes.js';
import { PackageService } from './packages.service.js';
import * as S from './content.schemas.js';

/**
 * COMPOSITION ROOT for content.
 *
 * Each content type is assembled here as repository -> service -> routes. The
 * wiring is explicit and in one place, so what a resource does is readable
 * without chasing decorators or a DI container, and any layer can be swapped
 * for one resource without affecting the others.
 *
 * Adding a content type: a Prisma model, a zod schema, and one block below.
 */

/**
 * Prisma's per-model delegates cannot be unified generically without heavy
 * conditional types. The cast is confined to this single helper rather than
 * being sprinkled across the codebase.
 */
const delegate = (d: unknown) => d as unknown as PrismaDelegate;

export function registerContentRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------- packages
  const packageRepo = new BaseRepository(delegate(prisma.package), {
    tourPlan: { orderBy: { sortOrder: 'asc' } },
    listItems: { orderBy: { sortOrder: 'asc' } },
    cardImage: true,
    bgImage: true,
  });

  registerCrudRoutes(app, {
    resource: 'packages',
    singular: 'Package',
    service: new PackageService(packageRepo, {
      singular: 'Package',
      hasSlug: true,
      hasPublished: true,
      hasSortOrder: true,
      slugFrom: 'packageName',
      // Package-level description is plain text on the site; the RICH text on a
      // package lives on its tour-plan days (see packages.extra.routes.ts).
      plainTextFields: ['description', 'metaDescription'],
      searchFields: ['packageName', 'location', 'duration'],
      imageFields: ['cardImage', 'bgImage'],
    }),
    createSchema: S.packageCreateSchema,
    updateSchema: S.packageUpdateSchema,
    hasSlug: true,
    hasSortOrder: true,
    revalidatePaths: (row) => [
      '/',
      '/packages',
      ...(row.slug ? [`/packages/${row.slug as string}`] : []),
      '/sitemap.xml',
    ],
  });

  // ------------------------------------------------------------ districts
  registerCrudRoutes(app, {
    resource: 'districts',
    singular: 'District',
    service: new BaseService(new BaseRepository(delegate(prisma.district)), {
      singular: 'District',
      hasSortOrder: true,
      searchFields: ['name'],
    }),
    createSchema: S.districtCreateSchema,
    updateSchema: S.districtUpdateSchema,
    hasSortOrder: true,
    revalidatePaths: () => ['/destinations'],
  });

  // --------------------------------------------------------- destinations
  registerCrudRoutes(app, {
    resource: 'destinations',
    singular: 'Destination',
    service: new BaseService(
      new BaseRepository(delegate(prisma.destination), {
        district: true,
        cardImage: true,
        bgImage: true,
        thumbnail: true,
      }),
      {
        singular: 'Destination',
        hasSlug: true,
        hasPublished: true,
        hasSortOrder: true,
        slugFrom: 'destinationName',
        richTextFields: ['description'],
        plainTextFields: ['shortDes', 'metaDescription'],
        searchFields: ['destinationName', 'distance'],
        imageFields: ['cardImage', 'bgImage', 'thumbnail'],
      },
    ),
    createSchema: S.destinationCreateSchema,
    updateSchema: S.destinationUpdateSchema,
    hasSlug: true,
    hasSortOrder: true,
    revalidatePaths: (row) => [
      '/',
      '/destinations',
      ...(row.slug ? [`/destinations/${row.slug as string}`] : []),
      '/sitemap.xml',
    ],
  });

  // ---------------------------------------------------------------- blogs
  registerCrudRoutes(app, {
    resource: 'blogs',
    singular: 'Blog post',
    service: new BaseService(
      new BaseRepository(delegate(prisma.blog), { cardImage: true, bgImage: true }),
      {
      singular: 'Blog post',
      hasSlug: true,
      hasPublished: true,
      hasSortOrder: true,
      slugFrom: 'title',
      richTextFields: ['description'],
      plainTextFields: ['shortDes', 'metaDescription'],
      searchFields: ['title', 'author'],
      imageFields: ['cardImage', 'bgImage'],
    }),
    createSchema: S.blogCreateSchema,
    updateSchema: S.blogUpdateSchema,
    hasSlug: true,
    hasSortOrder: true,
    revalidatePaths: (row) => [
      '/',
      '/travelblogs',
      ...(row.slug ? [`/travelblogs/${row.slug as string}`] : []),
      '/sitemap.xml',
    ],
  });

  // --------------------------------------------------------- testimonials
  registerCrudRoutes(app, {
    resource: 'testimonials',
    singular: 'Testimonial',
    service: new BaseService(
      new BaseRepository(delegate(prisma.testimonial), { image: true }),
      {
      singular: 'Testimonial',
      hasPublished: true,
      hasSortOrder: true,
      plainTextFields: ['description'],
      searchFields: ['name', 'place'],
      imageFields: ['image'],
    }),
    createSchema: S.testimonialCreateSchema,
    updateSchema: S.testimonialUpdateSchema,
    hasSortOrder: true,
    revalidatePaths: () => ['/'],
  });

  // ---------------------------------------------------------- hero slides
  registerCrudRoutes(app, {
    resource: 'hero-slides',
    singular: 'Hero slide',
    service: new BaseService(
      new BaseRepository(delegate(prisma.heroSlide), { image: true }),
      {
        singular: 'Hero slide',
        hasPublished: true,
        hasSortOrder: true,
        imageFields: ['image'],
      },
    ),
    createSchema: S.heroSlideCreateSchema,
    updateSchema: S.heroSlideUpdateSchema,
    hasSortOrder: true,
    revalidatePaths: () => ['/'],
  });
}
