import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once, at import time. A missing or malformed variable
 * crashes the process on boot with a readable message rather than surfacing as a
 * confusing runtime failure hours later.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),

  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@thediscoverkashmir.in'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('change-me-now'),
  SEED_ADMIN_NAME: z.string().default('Site Admin'),

  /** Extra allowed origins. Defaults to SITE_BASE_URL. */
  CORS_ORIGINS: z.string().optional(),

  // "local"      writes to disk and serves via this API. No account needed;
  //              correct anywhere with a persistent filesystem.
  // "cloudinary" stores on Cloudinary and delivers via its CDN with automatic
  //              format and quality optimisation. Recommended for production.
  // "blob"       Vercel Blob; required on serverless hosts where written files
  //              vanish with the instance.
  STORAGE_DRIVER: z.enum(['local', 'cloudinary', 'blob']).default('local'),
  UPLOAD_DIR: z.string().default('uploads'),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  /** Everything is stored under this prefix, keeping the media library tidy. */
  CLOUDINARY_FOLDER: z.string().default('discover-kashmir'),
  /**
   * Longest edge, in pixels, that a delivered image may have. Originals are
   * kept at full size; this only caps DELIVERY. 1920 fits a full-bleed desktop
   * hero — raising it costs bytes on every page view for pixels nobody sees.
   */
  IMAGE_MAX_WIDTH: z.coerce.number().int().min(320).max(4000).default(1920),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  // Absolute base URL of THIS API, used to build public URLs for local uploads.
  PUBLIC_BASE_URL: z.string().url().optional(),

  // --- CCAvenue ------------------------------------------------------------
  // 'test' and 'live' are DIFFERENT hosts with different credentials. Getting
  // this wrong either fails every transaction or takes real money by accident.
  CCAVENUE_ENV: z.enum(['test', 'live']).default('test'),
  CCAVENUE_MERCHANT_ID: z.string().optional(),
  CCAVENUE_ACCESS_CODE: z.string().optional(),
  /// The 32-character working key. NEVER commit this or send it to a browser.
  CCAVENUE_WORKING_KEY: z.string().optional(),
  /// Public base URL of the WEBSITE, used to build the customer-facing return
  /// links the gateway redirects to after payment.
  SITE_BASE_URL: z.string().url().default('http://localhost:3000'),

  REVALIDATE_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

/**
 * Splits CORS_ORIGINS into exact origins and wildcard patterns.
 *
 * `*` expands to `[^.]*` — it matches within a single hostname label and never
 * across a dot. That distinction is the whole security boundary here:
 * `https://*-basitbcs-projects.vercel.app` then matches only hostnames whose
 * final labels are exactly `basitbcs-projects.vercel.app`, a namespace Vercel
 * only lets that team publish under.
 *
 * Keep the team suffix in any pattern you add. A bare `https://*.vercel.app`
 * would let anyone's Vercel deployment make credentialed calls to this API.
 */
function parseCorsOrigins(value: string | undefined, fallback: string) {
  const entries = (value ? value.split(',') : [fallback])
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const exact: string[] = [];
  const patterns: RegExp[] = [];

  for (const entry of entries) {
    if (!entry.includes('*')) {
      exact.push(entry);
      continue;
    }
    const source = entry
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]*');
    patterns.push(new RegExp(`^${source}$`));
  }

  return { exact, patterns };
}

const parsedCorsOrigins = parseCorsOrigins(raw.CORS_ORIGINS, raw.SITE_BASE_URL);

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  /**
   * Browsers that may call this API. Defaults to the website itself, which is
   * the only origin that normally needs access — set CORS_ORIGINS only to add
   * more (a staging site, a separate admin host).
   */
  corsOrigins: parsedCorsOrigins.exact,
  /**
   * Entries containing `*` become patterns. This exists for preview deploys:
   * Vercel rebuilds the hostname on every push (discoverkashmir-<hash>-<team>
   * .vercel.app), so an exact allowlist can never match one.
   */
  corsOriginPatterns: parsedCorsOrigins.patterns,
  /** Each driver has its own precondition; local has none. */
  uploadsEnabled:
    raw.STORAGE_DRIVER === 'local' ||
    Boolean(
      raw.CLOUDINARY_CLOUD_NAME && raw.CLOUDINARY_API_KEY && raw.CLOUDINARY_API_SECRET,
    ),
  /** Falls back to localhost so local uploads produce a working URL in dev. */
  PUBLIC_BASE_URL: raw.PUBLIC_BASE_URL ?? `http://localhost:${raw.PORT}`,
  /** Always the website's revalidate endpoint — derived, never configured. */
  FRONTEND_REVALIDATE_URL: `${raw.SITE_BASE_URL.replace(/\/$/, '')}/api/revalidate`,
  /** Rebuild pings need only the shared secret; the URL is derived. */
  revalidateEnabled: Boolean(raw.REVALIDATE_SECRET),
};

export type Env = typeof env;
