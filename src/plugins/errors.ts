import type { FastifyError, FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

/**
 * One place that decides what the client sees when something goes wrong.
 *
 * Two rules:
 *  - Expected failures (AppError, validation, known Prisma codes) return a
 *    specific, useful message.
 *  - Anything else is a bug. It is logged with its stack and reported as a bare
 *    500 so database internals and file paths never reach the browser.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} does not exist`,
      },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Request body/params/query failed zod validation.
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The submitted data is not valid.',
          details: error.validation.map((issue) => {
            // instancePath is empty for root-level issues; zod's own path is the
            // fallback that tells the editor which field actually failed.
            const zodPath = (
              issue.params as { issue?: { path?: (string | number)[] } } | undefined
            )?.issue?.path;

            return {
              field: issue.instancePath.replace(/^\//, '') || zodPath?.join('.') || undefined,
              message: issue.message,
            };
          }),
        },
      });
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      switch (error.code) {
        case 'P2002': {
          const target = (error.meta?.target as string[] | undefined)?.join(', ');
          return reply.code(409).send({
            error: {
              code: 'DUPLICATE',
              message: target
                ? `Another record already uses that ${target}.`
                : 'That value is already taken.',
            },
          });
        }
        case 'P2003':
          return reply.code(409).send({
            error: {
              code: 'FOREIGN_KEY',
              message: 'That record is still referenced by other data.',
            },
          });
        case 'P2025':
          return reply.code(404).send({
            error: { code: 'NOT_FOUND', message: 'The requested record does not exist.' },
          });
        default:
          break;
      }
    }

    // Fastify's own client errors (payload too large, bad JSON, rate limit, ...)
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
      });
    }

    request.log.error({ err: error }, 'Unhandled error');

    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
      },
    });
  });
}
