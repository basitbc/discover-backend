import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { badRequest, serviceUnavailable } from './errors.js';

/**
 * Image storage, behind one interface with two drivers.
 *
 *   local      — writes to disk and serves the files from this API. No account
 *                needed; correct for development.
 *   cloudinary — CDN delivery with automatic format and quality optimisation,
 *                and no dependence on a persistent disk. Used in production.
 *
 * Everything funnels through here, so adding S3 later means implementing one
 * more driver rather than touching any call site.
 */

const ALLOWED_MIME = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
]);

export interface StoredFile {
  url: string;
  pathname: string;
  contentType: string;
  size: number;
  /** Present when the provider reports them (Cloudinary does; local does not). */
  width?: number;
  height?: number;
  format?: string;
}

/**
 * Magic-number check. Both the browser-supplied MIME type and the filename are
 * attacker-controlled, so the bytes decide whether this is really an image.
 */
function detectImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return null;
}

/** Strips any path components — a filename must never be able to escape the folder. */
function safeStem(originalName: string): string {
  return (
    basename(originalName)
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'image'
  );
}

function validate(buffer: Buffer): string {
  if (buffer.length === 0) throw badRequest('Uploaded file is empty');

  if (buffer.length > env.MAX_UPLOAD_BYTES) {
    const mb = (env.MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(1);
    throw badRequest(`Image is larger than the ${mb} MB limit`);
  }

  const detected = detectImageType(buffer);
  if (!detected || !ALLOWED_MIME.has(detected)) {
    throw badRequest(
      'File is not a supported image. Allowed formats: JPG, PNG, WebP, AVIF, GIF.',
    );
  }

  return detected;
}

// ------------------------------------------------------------- local driver

async function uploadLocal(
  buffer: Buffer,
  originalName: string,
  folder: string,
  contentType: string,
): Promise<StoredFile> {
  const ext = ALLOWED_MIME.get(contentType)!;
  // Random suffix so two uploads named hero.jpg cannot overwrite each other.
  const filename = `${safeStem(originalName)}-${randomBytes(4).toString('hex')}.${ext}`;
  const dir = join(env.UPLOAD_DIR, folder);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buffer);

  const pathname = `${folder}/${filename}`;

  return {
    url: `${env.PUBLIC_BASE_URL}/uploads/${pathname}`,
    pathname,
    contentType,
    size: buffer.length,
  };
}

async function deleteLocal(url: string): Promise<boolean> {
  const prefix = `${env.PUBLIC_BASE_URL}/uploads/`;
  if (!url.startsWith(prefix)) return false;

  // Rebuild the path from sanitised segments rather than trusting the URL.
  const relative = url.slice(prefix.length).split('/').filter((s) => s && s !== '..');
  if (relative.length === 0) return false;

  const target = join(env.UPLOAD_DIR, ...relative);
  if (!existsSync(target)) return false;

  await unlink(target);
  return true;
}

// -------------------------------------------------------- cloudinary driver

let cloudinaryReady = false;

async function getCloudinary() {
  const { v2 } = await import('cloudinary');

  if (!cloudinaryReady) {
    v2.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    cloudinaryReady = true;
  }

  return v2;
}

/**
 * Rewrites a delivery URL with the transformations that actually matter.
 *
 *   f_auto        AVIF or WebP for browsers that accept them, JPEG otherwise
 *   q_auto        per-image quality that is visually lossless
 *   w_N,c_limit   caps the long edge, and NEVER upscales a smaller image
 *
 * The width cap is the load-bearing part. Measured on this site's heaviest
 * photo — a 4000x6000, 4.86 MB JPEG:
 *
 *   f_auto,q_auto                  3947 KB   (21% saved — re-encode only)
 *   f_auto,q_auto,w_1920,c_limit    889 KB   (82% saved)
 *
 * Format and quality alone barely help when the source is 24 megapixels; the
 * bytes are in the pixels. 1920 covers a full-bleed hero on a desktop display
 * while cutting the file by an order of magnitude.
 *
 * Baked into the STORED url so every consumer benefits — including the call
 * sites using a plain <img> or a CSS background, which never pass through
 * next/image. Where next/image IS used it resizes again per breakpoint, so
 * phones receive far less than this cap.
 */
function withAutoOptimisation(secureUrl: string): string {
  const transform = `f_auto,q_auto,w_${env.IMAGE_MAX_WIDTH},c_limit`;
  return secureUrl.replace('/image/upload/', `/image/upload/${transform}/`);
}

/**
 * Recovers the public_id from a delivery URL, since the schema stores a plain
 * URL rather than a separate id column.
 *
 *   https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/v17/dk/pkg/a.jpg
 *   -> dk/pkg/a
 */
function publicIdFromUrl(url: string): string | null {
  const match = url.match(/\/image\/upload\/(.+)$/);
  if (!match?.[1]) return null;

  const segments = match[1].split('/');

  // Drop any leading transformation segment and the version marker.
  while (segments.length > 0) {
    const head = segments[0]!;
    const isTransformation = /^[a-z]{1,3}_[^/]+/.test(head) && head.includes('_');
    const isVersion = /^v\d+$/.test(head);
    if (isTransformation || isVersion) segments.shift();
    else break;
  }

  if (segments.length === 0) return null;
  return segments.join('/').replace(/\.[^./]+$/, '');
}

async function uploadCloudinary(
  buffer: Buffer,
  originalName: string,
  folder: string,
  contentType: string,
): Promise<StoredFile> {
  const cloudinary = await getCloudinary();

  // The suffix is added HERE rather than relying on Cloudinary's
  // `unique_filename`, which it ignores whenever an explicit public_id is
  // supplied. Without it, two different photos both named image.jpg resolve to
  // the same public_id and the second upload silently returns the first — so a
  // staff member would replace one record's picture by editing another.
  const publicId = `${safeStem(originalName)}-${randomBytes(4).toString('hex')}`;

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${env.CLOUDINARY_FOLDER}/${folder}`,
        public_id: publicId,
        overwrite: false,
        resource_type: 'image',
      },
      (error, uploaded) => {
        if (error) reject(error);
        else if (!uploaded) reject(new Error('Cloudinary returned no result'));
        else resolve(uploaded as unknown as Record<string, unknown>);
      },
    );
    stream.end(buffer);
  });

  const secureUrl = String(result.secure_url);

  return {
    url: withAutoOptimisation(secureUrl),
    pathname: String(result.public_id),
    contentType,
    size: Number(result.bytes) || buffer.length,
    width: Number(result.width) || undefined,
    height: Number(result.height) || undefined,
    format: result.format ? String(result.format) : undefined,
  };
}

async function deleteCloudinary(url: string): Promise<boolean> {
  if (!url.includes('res.cloudinary.com')) return false;

  const publicId = publicIdFromUrl(url);
  if (!publicId) return false;

  const cloudinary = await getCloudinary();
  const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });

  return result.result === 'ok';
}

// ----------------------------------------------------------------- public API

export async function uploadImage(
  buffer: Buffer,
  originalName: string,
  folder = 'general',
): Promise<StoredFile> {
  const contentType = validate(buffer);

  if (env.STORAGE_DRIVER === 'cloudinary') {
    if (!env.uploadsEnabled) {
      throw serviceUnavailable(
        'Storage is set to "cloudinary" but its credentials are missing. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, or set STORAGE_DRIVER=local to store images on this server.',
      );
    }
    return uploadCloudinary(buffer, originalName, folder, contentType);
  }

  return uploadLocal(buffer, originalName, folder, contentType);
}

/**
 * Best-effort delete. Images living in the Next app's public/ folder are not
 * owned by this service and are skipped rather than treated as an error.
 */
export async function deleteImage(url: string): Promise<boolean> {
  try {
    // Dispatch on the URL, not the configured driver: after switching drivers
    // the database still holds URLs created by the previous one, and those must
    // remain deletable.
    if (url.includes('res.cloudinary.com')) return await deleteCloudinary(url);
    return await deleteLocal(url);
  } catch {
    // A failed cleanup must not fail the request that triggered it.
    return false;
  }
}
