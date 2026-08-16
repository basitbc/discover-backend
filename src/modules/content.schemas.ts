import { z } from 'zod';

/**
 * Request contracts for every content type.
 *
 * These are the single source of truth: fastify-type-provider-zod validates
 * incoming bodies against them AND derives the Swagger documentation from them,
 * so the docs at /docs cannot drift away from what the API actually accepts.
 *
 * Conventions:
 *  - `.nullish()` on optional columns lets the admin send `null` to CLEAR a
 *    field, while omitting the key leaves it untouched (Prisma treats
 *    `undefined` as "no change").
 *  - Update schemas are `.partial()` of create, so PATCH is genuinely partial.
 */

const slugField = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug may contain only lowercase letters, numbers and hyphens',
  )
  .max(200)
  .optional();

// Images are now rows in the media library, so writes carry an id. Null clears
// the field; omitting the key leaves it unchanged.
const imageField = z.number().int().positive().nullish();
const seoFields = {
  metaTitle: z.string().trim().max(200).nullish(),
  metaDescription: z.string().trim().max(400).nullish(),
};
const publishFields = {
  published: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
};

// --------------------------------------------------------------- packages

export const tourPlanDaySchema = z.object({
  day: z.string().trim().min(1).max(20),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000),
  note: z.string().max(5_000).nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const packageCreateSchema = z.object({
  slug: slugField,
  packageName: z.string().trim().min(1).max(200),
  duration: z.string().trim().min(1).max(100),
  location: z.string().trim().min(1).max(200),
  // Both price fields are free text on purpose: the live data contains
  // "1,20,999" and "Whatsapp for quote". Do not coerce these to numbers.
  notPrice: z.string().trim().max(100).nullish(),
  price: z.string().trim().min(1).max(200),
  cardImageId: imageField,
  bgImageId: imageField,
  mealsPlan: z.string().trim().max(100).nullish(),
  vehicle: z.string().trim().max(100).nullish(),
  pickAndDrop: z.string().trim().max(200).nullish(),
  description: z.string().max(20_000),
  ...publishFields,
  ...seoFields,
});

export const packageUpdateSchema = packageCreateSchema.partial();

export const replaceTourPlanSchema = z.object({
  items: z.array(tourPlanDaySchema).max(60),
});

export const listKindSchema = z.enum([
  'INCLUSION',
  'EXCLUSION',
  'THING_TO_CARRY',
  'MAJOR_ACTIVITY',
  'TERM',
]);

export const replaceListItemsSchema = z.object({
  kind: listKindSchema,
  items: z.array(z.string().trim().min(1).max(2_000)).max(200),
});

// ----------------------------------------------------------- destinations

export const districtCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  sortOrder: z.number().int().min(0).optional(),
});
export const districtUpdateSchema = districtCreateSchema.partial();

export const destinationCreateSchema = z.object({
  slug: slugField,
  destinationName: z.string().trim().min(1).max(200),
  districtId: z.number().int().positive(),
  distance: z.string().trim().max(300).nullish(),
  bestTimeToVisit: z.string().trim().max(500).nullish(),
  shortDes: z.string().max(2_000),
  description: z.string().max(50_000),
  cardImageId: imageField,
  bgImageId: imageField,
  thumbnailId: imageField,
  ...publishFields,
  ...seoFields,
});

export const destinationUpdateSchema = destinationCreateSchema.partial();

// ------------------------------------------------------------------ blogs

export const blogCreateSchema = z.object({
  slug: slugField,
  title: z.string().trim().min(1).max(300),
  cardImageId: imageField,
  bgImageId: imageField,
  shortDes: z.string().max(2_000),
  description: z.string().max(50_000),
  author: z.string().trim().max(120).nullish(),
  publishedAt: z.coerce.date().nullish(),
  ...publishFields,
  ...seoFields,
});

export const blogUpdateSchema = blogCreateSchema.partial();

// ---------------------------------------------------- homepage / chrome

export const testimonialCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  place: z.string().trim().min(1).max(120),
  imageId: imageField,
  description: z.string().max(5_000),
  ...publishFields,
});
export const testimonialUpdateSchema = testimonialCreateSchema.partial();

export const heroSlideCreateSchema = z.object({
  imageId: imageField,
  ...publishFields,
});
export const heroSlideUpdateSchema = heroSlideCreateSchema.partial();

export const siteSettingsUpdateSchema = z
  .object({
    logoText: z.string().trim().min(1).max(120),
    phoneNumber: z.string().trim().min(1).max(40),
    email: z.string().trim().email().max(200),
    whatsappNumber: z.string().trim().min(1).max(40),
    address: z.string().trim().min(1).max(1_000),
    about1: z.string().max(5_000),
    about2: z.string().max(5_000),
    aboutImageBackId: imageField,
    aboutImageFrontId: imageField,
    contactBgImageId: imageField,
    packagesBannerId: imageField,
    destinationsBannerId: imageField,
    blogsBannerId: imageField,
    packagesOverviewId: imageField,
    blogSectionBgId: imageField,
    headerLogoId: imageField,
    footerLogoId: imageField,
  })
  .partial();

// ------------------------------------------------------------------- auth

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(10, 'New password must be at least 10 characters')
    .max(200),
});
