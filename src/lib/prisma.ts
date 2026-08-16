import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Cached on globalThis so `tsx watch` reloads reuse one connection pool instead
 * of opening a new one per reload until Postgres starts refusing connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDevelopment ? ['warn', 'error'] : ['error'],
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}

export type Prisma = typeof prisma;
