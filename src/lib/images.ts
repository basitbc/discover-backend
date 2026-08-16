export interface ImageRow {
  id: number;
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Collapses joined Image rows into plain URL strings for PUBLIC responses.
 *
 *   { cardImage: { id: 9, url: "https://…", alt: "Sonmarg" } }
 *   -> { cardImage: "https://…", cardImageAlt: "Sonmarg", cardImageId: 9 }
 *
 * Two reasons for flattening rather than returning the nested object:
 *
 *  - The website already consumes `cardImage` as a string in a dozen places,
 *    including CSS `background: url()` where an object is useless. Keeping the
 *    contract means the media library was a purely additive change for it.
 *  - Alt text travels with the image, so pages can become accessible without
 *    every component learning the shape of an Image row.
 *
 * ADMIN responses deliberately skip this: the editor needs the id to drive the
 * picker, and the full row to show dimensions and file size.
 */
export function flattenImageFields(
  row: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  if (fields.length === 0) return row;

  const out: Record<string, unknown> = { ...row };

  for (const field of fields) {
    const value = out[field] as ImageRow | null | undefined;

    if (value && typeof value === 'object' && 'url' in value) {
      out[field] = value.url;
      out[`${field}Alt`] = value.alt ?? null;
      out[`${field}Id`] = value.id;
      out[`${field}Width`] = value.width;
      out[`${field}Height`] = value.height;
    } else {
      // Explicit null rather than undefined so the shape is stable and the
      // frontend's `|| ''` fallbacks behave predictably.
      out[field] = null;
      out[`${field}Alt`] = null;
    }
  }

  return out;
}

/** Prisma `include` clause for a set of image relations. */
export function imageInclude(fields: string[]): Record<string, boolean> {
  return Object.fromEntries(fields.map((f) => [f, true]));
}
