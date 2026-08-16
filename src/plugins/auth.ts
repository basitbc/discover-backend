import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * JWT authentication.
 *
 * The admin UI lives in the Next app on a different origin, so a cookie session
 * would need cross-site cookies. A bearer token sent explicitly on each admin
 * request avoids that entirely and keeps this API stateless — nothing to share
 * between instances when it scales horizontally.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  app.decorate(
    'authenticate',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      try {
        await request.jwtVerify();
      } catch {
        // Deliberately vague: distinguishing "expired" from "malformed" from
        // "wrong signature" only helps someone probing the endpoint.
        throw unauthorized('Invalid or expired session. Please sign in again.');
      }
    },
  );

  app.decorate(
    'requireRole',
    (...roles: Array<'ADMIN' | 'EDITOR'>) =>
      async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        try {
          await request.jwtVerify();
        } catch {
          throw unauthorized('Invalid or expired session. Please sign in again.');
        }

        if (!roles.includes(request.user.role)) {
          throw forbidden('Your account does not have permission to do that.');
        }
      },
  );
}
