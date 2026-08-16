import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';

import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerAuthRoutes } from './modules/auth.routes.js';
import { registerContentRoutes } from './modules/content.routes.js';
import { registerPackageExtraRoutes } from './modules/packages.extra.routes.js';
import { registerSettingsRoutes } from './modules/settings.routes.js';
import { registerUploadRoutes } from './modules/uploads.routes.js';
import { registerImageRoutes } from './modules/images.routes.js';
import { registerPaymentRoutes } from './modules/payments.routes.js';
import { registerGatewayRoutes } from './modules/payments.gateway.routes.js';

export const API_PREFIX = '/api/v1';

/**
 * Builds a fully configured Fastify instance without starting it.
 *
 * Kept separate from server.ts so tests can build an app, drive it with
 * `app.inject()` and never bind a port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty logs are a dev convenience; production emits JSON for log tooling.
      ...(env.isDevelopment
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Trust the proxy so rate limiting sees the real client IP behind a load
    // balancer rather than limiting the balancer itself.
    trustProxy: true,
    bodyLimit: 1_048_576, // 1 MB for JSON; uploads go through multipart below.
  });

  // zod schemas in route definitions become both validation and Swagger docs.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /**
   * Fastify's default JSON parser rejects an EMPTY body when the request still
   * declares `Content-Type: application/json`, with FST_ERR_CTP_EMPTY_JSON_BODY.
   *
   * That combination is completely normal on DELETE — plenty of HTTP clients
   * and proxies attach a default content-type regardless of whether there is a
   * payload — and the caller gets a confusing 400 instead of their delete. An
   * empty body is treated as "no body" rather than as malformed JSON.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = (body as string).trim();
      if (text.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch {
        const error = new Error('Body is not valid JSON') as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error);
      }
    },
  );

  registerErrorHandler(app);

  await app.register(helmet, {
    // The API serves JSON and the Swagger UI, never site HTML.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin(origin, callback) {
      // Same-origin/server-side calls (curl, SSR fetches) send no Origin header.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);

      // In development, accept ANY localhost port. Next silently moves to 3001
      // when 3000 is taken, and pinning a single port there turns a routine
      // port shuffle into a wall of CORS failures across the whole admin.
      // Production stays on the explicit allowlist.
      if (env.isDevelopment && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      // Deny WITHOUT throwing. Passing an Error makes Fastify return 500, so a
      // disallowed origin looks like a server crash instead of what it is —
      // the browser blocks it on the missing header either way.
      app.log.warn({ origin }, 'Rejected cross-origin request');
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Per-route overrides (login, uploads) are set via each route's `config`.
    keyGenerator: (request) => request.ip,
  });

  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
  });

  // CCAvenue POSTs its result as application/x-www-form-urlencoded, which
  // Fastify does not parse out of the box. Without this the payment callback
  // silently arrives with an empty body and every transaction looks failed.
  await app.register(formbody);

  // Serve locally-stored uploads. Only mounted for the local driver — with blob
  // the files live on a CDN and this route would be dead weight.
  if (env.STORAGE_DRIVER === 'local') {
    const uploadRoot = resolve(env.UPLOAD_DIR);
    await mkdir(uploadRoot, { recursive: true });

    await app.register(fastifyStatic, {
      root: uploadRoot,
      prefix: '/uploads/',
      decorateReply: false,
      index: false,
      // Content is immutable: every filename carries a random suffix, so a
      // given URL never changes and can be cached hard.
      cacheControl: true,
      maxAge: '365d',
      // X-Content-Type-Options: nosniff is already applied globally by helmet.
    });
  }

  await registerAuth(app);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Discover Kashmir Content API',
        description:
          'Content backend for the Discover Kashmir website. Public GET routes serve the site; /admin routes require a bearer token.',
        version: '1.0.0',
      },
      // Root-relative, NOT the /api/v1 prefix. Some routes genuinely live at
      // the root (/health, plus the /payment and /ccav* checkout paths), so a
      // prefixed server base would make Try-it-out call /api/v1/payment —
      // which does not exist. Combined with
      // stripBasePath:false below, every documented path is absolute and
      // therefore correct for both groups.
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
    // Keep the /api/v1 prefix in documented paths; see the servers note above.
    stripBasePath: false,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // ------------------------------------------------------------ liveness
  app.get(
    '/health',
    { schema: { tags: ['meta'], summary: 'Liveness and database check' } },
    async (_request, reply) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: 'ok', database: 'up' };
      } catch (error) {
        app.log.error({ err: error }, 'Health check failed');
        return reply.code(503).send({ status: 'degraded', database: 'down' });
      }
    },
  );

  // Checkout routes for the API domain, mounted at the ROOT rather than under
  // /api/v1 — CCAvenue returns the customer to exactly the path we send it, and
  // these are the paths this domain publishes.
  registerGatewayRoutes(app);

  // -------------------------------------------------------------- routes
  await app.register(
    async (instance) => {
      registerAuthRoutes(instance);
      registerContentRoutes(instance);
      registerPackageExtraRoutes(instance);
      registerSettingsRoutes(instance);
      registerUploadRoutes(instance);
      registerImageRoutes(instance);
      registerPaymentRoutes(instance);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
