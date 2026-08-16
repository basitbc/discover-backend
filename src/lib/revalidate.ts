import { env } from '../config/env.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Tells the Next site to rebuild the pages a content change affected, so a save
 * in the admin shows up on the live site within seconds instead of waiting for
 * the next deploy.
 *
 * Deliberately fire-and-forget: if the frontend is down or slow, the admin save
 * has already succeeded and must not fail because of it. Failures are logged.
 */
export function revalidateFrontend(
  paths: string[],
  logger: FastifyBaseLogger,
): void {
  if (!env.revalidateEnabled || paths.length === 0) return;

  const unique = [...new Set(paths)];

  void (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(env.FRONTEND_REVALIDATE_URL!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': env.REVALIDATE_SECRET!,
        },
        body: JSON.stringify({ paths: unique }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn(
          { status: response.status, paths: unique },
          'Frontend revalidation returned a non-OK status',
        );
      } else {
        logger.info({ paths: unique }, 'Frontend revalidation requested');
      }
    } catch (error) {
      logger.warn({ err: error, paths: unique }, 'Frontend revalidation failed');
    }
  })();
}
