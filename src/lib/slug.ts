import slugifyLib from 'slugify';

/**
 * Slug rules for NEW content.
 *
 * `strict: true` drops characters the old site used to leave in place. The
 * original frontend called plain `slugify(name).toLowerCase()`, which produced
 * URLs containing apostrophes and colons, e.g.
 *   trekking-in-kashmir:-kashmir-is-trekker's-delight
 *
 * Those original slugs are preserved verbatim by the seed script so existing URLs
 * keep working. Anything created from here on gets a clean slug instead.
 */
export function toSlug(input: string): string {
  return slugifyLib(input, { lower: true, strict: true, trim: true });
}

interface UniqueSlugArgs {
  /** Any Prisma delegate exposing findFirst, e.g. prisma.package */
  findExisting: (slug: string) => Promise<{ id: number } | null>;
  desired: string;
  /** When updating, the row being edited must not collide with itself. */
  excludeId?: number;
}

/**
 * Appends -2, -3, ... until the slug is free. Two editors saving similar titles
 * at the same moment can still race here; the unique index on `slug` is the real
 * guarantee, and the resulting P2002 is surfaced as a 409.
 */
export async function ensureUniqueSlug({
  findExisting,
  desired,
  excludeId,
}: UniqueSlugArgs): Promise<string> {
  const base = desired || 'item';
  let candidate = base;
  let suffix = 1;

  for (;;) {
    const existing = await findExisting(candidate);
    if (!existing || existing.id === excludeId) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}
