/**
 * Migrates the Discover Kashmir site's static JSON into Postgres.
 *
 * NOTE: this seeds TEXT content only. Images are rows in the media library and
 * are attached through the admin, so a freshly seeded database has content
 * without pictures. The original one-off image import has already run; a real
 * environment should be restored from a database backup rather than re-seeded.
 *
 * Reads from ../discoverKashmir-NEXTjs/Data and is IDEMPOTENT — every write is
 * an upsert keyed on slug or natural key, so running it twice is harmless.
 *
 *   npm run seed
 *
 * The single most important rule here: SLUGS MUST NOT CHANGE. The site built
 * its URLs with plain `slugify(name).toLowerCase()`, which leaves apostrophes
 * and colons in place. Those exact strings are reproduced below so every
 * already-published URL keeps resolving. New content created through the admin
 * gets clean, strict slugs instead (see src/lib/slug.ts).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, type ListKind } from '@prisma/client';
import bcrypt from 'bcryptjs';
import slugify from 'slugify';
import 'dotenv/config';

const prisma = new PrismaClient();

const here = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = join(here, '..', '..', 'discoverKashmir-NEXTjs');
// The source JSON lives beside this script rather than in the frontend: the
// website no longer reads it, and keeping a second copy of the content there
// invites someone editing the wrong one.
const DATA_DIR = join(here, 'seed-data');
const PUBLIC_DIR = join(SITE_ROOT, 'public');

function readJson<T>(name: string): T {
  const path = join(DATA_DIR, name);
  if (!existsSync(path)) {
    throw new Error(
      `Cannot find ${path}. Expected the source JSON in prisma/seed-data/.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Reproduces the site's existing slug format exactly. Do not "improve" this. */
const originalSlug = (value: string): string => slugify(value).toLowerCase();

/** Only record an image path if the file actually exists in public/. */
function imageIfExists(relativePath: string): string | null {
  return existsSync(join(PUBLIC_DIR, relativePath)) ? `/${relativePath}` : null;
}

// --------------------------------------------------------------- source types

interface JsonPackage {
  id: string;
  packageName: string;
  duration: string;
  location: string;
  notPrice: string;
  price: string;
  image: string;
  bgImage: string;
  mealsPlan: string;
  vehicle: string;
  pickAndDrop: string;
  description: string;
  tourPlan: { day: string; title: string; description: string; note: string }[];
}

interface JsonDestination {
  id: number;
  destinationName: string;
  Image: string;
  District: string;
  distance: string;
  bestTimeToVisit: string;
  shortDes: string;
  description: string;
}

interface JsonBlog {
  id: string;
  Title: string;
  Image: string;
  bgImage: string;
  shortDes: string;
  description: string;
}

interface JsonDetails {
  Logo: string;
  phoneNumber: string;
  email: string;
  whatsappNumber: string;
  address: string;
  about1: string;
  about2: string;
  aboutImageBack: string;
  aboutImageFront: string;
}

interface JsonTestimonial {
  Name: string;
  Place: string;
  image: string;
  description: string;
}

type JsonMoreDetails = Record<string, string>;

// --------------------------------------------------------------------- seeds

async function seedDistricts(destinations: JsonDestination[]): Promise<Map<string, number>> {
  // The old site hardcoded this list in pages/destinations/index.js; the order
  // is preserved because it drove the order of sections on the page.
  const ordered = ['Srinagar', 'Baramulla', 'Anantnag', 'Budgam', 'Ganderbal', 'Bandipora'];
  const fromData = [...new Set(destinations.map((d) => d.District))];
  const all = [...ordered, ...fromData.filter((d) => !ordered.includes(d))];

  const map = new Map<string, number>();
  for (const [index, name] of all.entries()) {
    const row = await prisma.district.upsert({
      where: { name },
      update: { sortOrder: index },
      create: { name, sortOrder: index },
    });
    map.set(name, row.id);
  }

  console.log(`  districts       ${map.size}`);
  return map;
}

async function seedPackages(packages: JsonPackage[]): Promise<number> {
  let days = 0;

  for (const [index, item] of packages.entries()) {
    const slug = originalSlug(item.packageName);

    const data = {
      packageName: item.packageName,
      duration: item.duration,
      location: item.location,
      // Free text on purpose: the data contains "1,20,999" and
      // "Whatsapp for quote". Never coerce these to numbers.
      notPrice: item.notPrice || null,
      price: item.price,
      mealsPlan: item.mealsPlan || null,
      vehicle: item.vehicle || null,
      pickAndDrop: item.pickAndDrop || null,
      description: item.description,
      published: true,
      sortOrder: index,
    };

    const row = await prisma.package.upsert({
      where: { slug },
      update: data,
      create: { slug, ...data },
    });

    // Blank trailing rows padded the old JSON; drop anything with no title.
    const plan = item.tourPlan.filter((d) => d.title.trim().length > 0);

    await prisma.$transaction([
      prisma.tourPlanDay.deleteMany({ where: { packageId: row.id } }),
      ...(plan.length > 0
        ? [
            prisma.tourPlanDay.createMany({
              data: plan.map((d, i) => ({
                packageId: row.id,
                day: d.day || String(i + 1),
                title: d.title,
                description: d.description,
                note: d.note || null,
                sortOrder: i,
              })),
            }),
          ]
        : []),
    ]);

    days += plan.length;
  }

  console.log(`  packages        ${packages.length} (${days} tour-plan days)`);
  return packages.length;
}

async function seedGlobalLists(more: JsonMoreDetails): Promise<number> {
  // Every field was a single semicolon-delimited string that the old frontend
  // split at render time. They become rows with packageId = null, i.e. the
  // global defaults every package inherits.
  const mapping: Record<string, ListKind> = {
    inclusions: 'INCLUSION',
    exclusions: 'EXCLUSION',
    thingsToCarry: 'THING_TO_CARRY',
    majorActivities: 'MAJOR_ACTIVITY',
    termsAndConditions: 'TERM',
  };

  let total = 0;

  for (const [field, kind] of Object.entries(mapping)) {
    const raw = more[field];
    if (!raw) continue;

    const items = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    await prisma.$transaction([
      prisma.packageListItem.deleteMany({ where: { packageId: null, kind } }),
      ...(items.length > 0
        ? [
            prisma.packageListItem.createMany({
              data: items.map((text, i) => ({
                packageId: null,
                kind,
                text,
                sortOrder: i,
              })),
            }),
          ]
        : []),
    ]);

    total += items.length;
  }

  console.log(`  package lists   ${total} global default items`);
  return total;
}

async function seedDestinations(
  destinations: JsonDestination[],
  districts: Map<string, number>,
): Promise<number> {
  for (const [index, item] of destinations.entries()) {
    const slug = originalSlug(item.destinationName);
    const districtId = districts.get(item.District);
    if (!districtId) throw new Error(`Unknown district "${item.District}"`);

    // The old JSX assembled these paths from the District and Image fields.
    // They become complete stored paths so nothing rebuilds them at render time.
    const base = `Assets/Images/Destinations/${item.District}/${item.Image}`;

    const data = {
      destinationName: item.destinationName,
      districtId,
      distance: item.distance || null,
      bestTimeToVisit: item.bestTimeToVisit || null,
      shortDes: item.shortDes,
      description: item.description,
      // Only Gulmarg actually has one; the rest stay null rather than pointing
      // at a 404 in Open Graph tags.
      published: true,
      sortOrder: index,
    };

    await prisma.destination.upsert({
      where: { slug },
      update: data,
      create: { slug, ...data },
    });
  }

  console.log(`  destinations    ${destinations.length}`);
  return destinations.length;
}

async function seedBlogs(blogs: JsonBlog[]): Promise<number> {
  for (const [index, item] of blogs.entries()) {
    const slug = originalSlug(item.Title);

    const data = {
      title: item.Title,
      shortDes: item.shortDes,
      description: item.description,
      published: true,
      sortOrder: index,
    };

    await prisma.blog.upsert({
      where: { slug },
      update: data,
      create: { slug, ...data },
    });
  }

  console.log(`  blogs           ${blogs.length}`);
  return blogs.length;
}

async function seedTestimonials(testimonials: JsonTestimonial[]): Promise<number> {
  // No id or other natural key exists in the source, so name+place identifies a
  // row well enough to keep re-runs from duplicating.
  for (const [index, item] of testimonials.entries()) {
    const existing = await prisma.testimonial.findFirst({
      where: { name: item.Name, place: item.Place },
      select: { id: true },
    });

    const data = {
      name: item.Name,
      place: item.Place,
      description: item.description,
      published: true,
      sortOrder: index,
    };

    if (existing) {
      await prisma.testimonial.update({ where: { id: existing.id }, data });
    } else {
      await prisma.testimonial.create({ data });
    }
  }

  console.log(`  testimonials    ${testimonials.length}`);
  console.log(
    '     NOTE: the seeded testimonial text is placeholder copy (restaurant and',
  );
  console.log('     hotel reviews), not real travel reviews. Replace it in the admin.');
  return testimonials.length;
}

async function seedHeroSlides(): Promise<number> {
  // Lifted out of the hardcoded array in Components/HeroCarousel.
  const slides = ['hero1.jpg', 'hero2.jpg'];
  let created = 0;

  for (const [index, file] of slides.entries()) {
    const url = imageIfExists(`Assets/Images/Home/${file}`);
    if (!url) continue;

    const existing = await prisma.heroSlide.findFirst({ where: { sortOrder: index } });
    if (existing) {
      await prisma.heroSlide.update({
        where: { id: existing.id },
        data: { sortOrder: index, published: true },
      });
    } else {
      await prisma.heroSlide.create({
        data: { sortOrder: index, published: true },
      });
    }
    created += 1;
  }

  console.log(`  hero slides     ${created}`);
  return created;
}

async function seedSettings(details: JsonDetails): Promise<void> {
  const data = {
    logoText: details.Logo,
    phoneNumber: details.phoneNumber,
    email: details.email,
    whatsappNumber: details.whatsappNumber,
    address: details.address,
    about1: details.about1,
    about2: details.about2,
    // Data/Contact.json held only this, and six pages read it without ever
    // using the value. Folded in here so the admin can still change it.
  };

  await prisma.siteSettings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
  });

  console.log('  site settings   1');
}

async function seedAdmin(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@thediscoverkashmir.in').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-now';
  const name = process.env.SEED_ADMIN_NAME ?? 'Site Admin';

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.log(`  admin user      exists (${email}) — password left unchanged`);
    return;
  }

  await prisma.adminUser.create({
    data: {
      email,
      name,
      role: 'ADMIN',
      passwordHash: await bcrypt.hash(password, 12),
    },
  });

  console.log(`  admin user      created (${email})`);
  if (password === 'change-me-now') {
    console.log('     WARNING: default password in use. Change it immediately.');
  }
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(`Seeding from ${DATA_DIR}\n`);

  const packages = readJson<JsonPackage[]>('Packages.json');
  const destinations = readJson<JsonDestination[]>('Destinations.json');
  const blogs = readJson<JsonBlog[]>('Blog.json');
  const details = readJson<JsonDetails>('Details.json');
  const testimonials = readJson<JsonTestimonial[]>('Testimonials.json');
  const more = readJson<JsonMoreDetails>('MorePackageDetails.json');

  const districts = await seedDistricts(destinations);
  await seedPackages(packages);
  await seedGlobalLists(more);
  await seedDestinations(destinations, districts);
  await seedBlogs(blogs);
  await seedTestimonials(testimonials);
  await seedHeroSlides();
  await seedSettings(details);
  await seedAdmin();

  console.log('\nSeed complete. Slugs preserved from the live site:');
  for (const p of packages) console.log(`  /packages/${originalSlug(p.packageName)}`);
  for (const d of destinations) console.log(`  /destinations/${originalSlug(d.destinationName)}`);
  for (const b of blogs) console.log(`  /travelblogs/${originalSlug(b.Title)}`);
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
