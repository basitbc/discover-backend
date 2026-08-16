import type { FastifyRequest, FastifyReply } from 'fastify';

/** Shape of the signed JWT payload. */
export interface AuthTokenPayload {
  sub: number;
  email: string;
  name: string;
  role: 'ADMIN' | 'EDITOR';
}

declare module 'fastify' {
  interface FastifyInstance {
    /** onRequest hook that rejects the request unless a valid JWT is present. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Builds an onRequest hook that additionally requires one of `roles`. */
    requireRole: (
      ...roles: Array<'ADMIN' | 'EDITOR'>
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthTokenPayload;
    user: AuthTokenPayload;
  }
}
