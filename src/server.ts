import { buildApp, API_PREFIX } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';

/**
 * Process entrypoint: builds the app, binds the port, and shuts down cleanly.
 *
 * A graceful shutdown matters in a container: on SIGTERM the platform gives a
 * short grace period, and draining in-flight requests plus closing the Postgres
 * pool avoids both dropped responses and connection leaks on Neon.
 */
async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // A promise nobody awaited or a thrown-and-uncaught error leaves the process
  // in an unknown state. Log loudly and let the platform restart it.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      `API on http://localhost:${env.PORT}${API_PREFIX} — docs at http://localhost:${env.PORT}/docs`,
    );
    if (!env.uploadsEnabled) {
      app.log.warn('BLOB_READ_WRITE_TOKEN is not set: image uploads are disabled');
    }
    if (!env.revalidateEnabled) {
      app.log.warn(
        'Frontend revalidation is disabled: set FRONTEND_REVALIDATE_URL and REVALIDATE_SECRET',
      );
    }
  } catch (error) {
    app.log.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

void main();
