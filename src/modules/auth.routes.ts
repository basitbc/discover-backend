import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { unauthorized, notFound } from '../lib/errors.js';
import { changePasswordSchema, loginSchema } from './content.schemas.js';

/**
 * Credentials login issuing a JWT.
 *
 * The Next admin wraps this in a NextAuth Credentials provider: NextAuth posts
 * here, stores the returned token in its session cookie, and sends it as a
 * bearer token on subsequent admin API calls. That keeps session/cookie handling
 * in the frontend while this API stays stateless.
 */

// A real bcrypt hash of a value nobody will guess. Comparing against it when the
// email is unknown makes a failed login take the same time as a wrong password,
// so the endpoint cannot be used to enumerate which emails exist.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO1WPjK/JGrq4rHQXeGjTGZ4QU1YAe0Uu';

export const PASSWORD_SALT_ROUNDS = 12;

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post(
    '/auth/login',
    {
      config: {
        // Tighter than the global limit: this is the one endpoint worth brute
        // forcing, and 10 attempts a minute is far more than a human needs.
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Sign in and receive a bearer token',
        body: loginSchema,
      },
    },
    async (request) => {
      const { email, password } = request.body as z.infer<typeof loginSchema>;

      const user = await prisma.adminUser.findUnique({
        where: { email: email.toLowerCase() },
      });

      const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

      if (!user || !matches) {
        request.log.warn({ email }, 'Failed login attempt');
        throw unauthorized('Incorrect email or password');
      }

      const token = app.jwt.sign({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });

      return {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      };
    },
  );

  app.get(
    '/auth/me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['auth'],
        summary: 'Return the signed-in user',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const user = await prisma.adminUser.findUnique({
        where: { id: request.user.sub },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      });

      // The account was deleted while a token was still valid.
      if (!user) throw unauthorized('Your account no longer exists');

      return { user };
    },
  );

  app.post(
    '/auth/change-password',
    {
      onRequest: [app.authenticate],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Change your own password',
        body: changePasswordSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { currentPassword, newPassword } = request.body as z.infer<
        typeof changePasswordSchema
      >;

      const user = await prisma.adminUser.findUnique({ where: { id: request.user.sub } });
      if (!user) throw notFound('Account');

      const matches = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!matches) throw unauthorized('Current password is incorrect');

      await prisma.adminUser.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS) },
      });

      return { changed: true };
    },
  );
}
