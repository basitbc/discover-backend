import { prisma } from '../lib/prisma.js';

/**
 * DATA ACCESS LAYER.
 *
 * The only place in the application that talks to Prisma. Everything above it
 * works in terms of these methods, which means:
 *   - swapping the ORM, adding read replicas, or introducing a cache is a change
 *     to this file rather than to every route;
 *   - services can be unit-tested against a fake repository with no database.
 *
 * It intentionally contains NO business rules — no slug generation, no
 * sanitisation, no publish semantics. Those belong to the service layer.
 */

/**
 * Prisma generates a differently-typed delegate per model, and unifying them
 * generically needs conditional types that obscure more than they help. This
 * structural type names exactly what the repository uses; each concrete
 * repository is constructed with its real, fully-typed delegate.
 */
export interface PrismaDelegate {
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  findFirst(args?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  delete(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export type Row = Record<string, unknown>;

export interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>[];
  skip?: number;
  take?: number;
}

export class BaseRepository {
  constructor(
    protected readonly delegate: PrismaDelegate,
    protected readonly include?: Record<string, unknown>,
  ) {}

  private withInclude(args: Record<string, unknown>): Record<string, unknown> {
    return this.include ? { ...args, include: this.include } : args;
  }

  findMany(args: FindManyArgs): Promise<Row[]> {
    return this.delegate.findMany(this.withInclude({ ...args }));
  }

  count(where?: Record<string, unknown>): Promise<number> {
    return this.delegate.count({ where });
  }

  /** Returns rows and total in one round trip — every list endpoint needs both. */
  async findManyWithCount(args: FindManyArgs): Promise<{ rows: Row[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.findMany(args),
      this.count(args.where),
    ]);
    return { rows, total };
  }

  findById(id: number): Promise<Row | null> {
    return this.delegate.findUnique(this.withInclude({ where: { id } }));
  }

  findBySlug(slug: string, extraWhere?: Record<string, unknown>): Promise<Row | null> {
    return this.delegate.findFirst(this.withInclude({ where: { slug, ...extraWhere } }));
  }

  /** Slug-uniqueness probe. Selects only the id — never load a whole row for this. */
  async findIdBySlug(slug: string): Promise<{ id: number } | null> {
    return (await this.delegate.findUnique({
      where: { slug },
      select: { id: true },
    })) as { id: number } | null;
  }

  async exists(id: number): Promise<boolean> {
    const row = await this.delegate.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  }

  create(data: Row): Promise<Row> {
    return this.delegate.create(this.withInclude({ data }));
  }

  update(id: number, data: Row): Promise<Row> {
    return this.delegate.update(this.withInclude({ where: { id }, data }));
  }

  delete(id: number): Promise<Row> {
    return this.delegate.delete({ where: { id } });
  }

  /**
   * Applies a new ordering in ONE transaction, so a failure part-way through
   * cannot leave the list half-sorted.
   */
  async reorder(items: { id: number; sortOrder: number }[]): Promise<void> {
    await prisma.$transaction(
      items.map((item) =>
        this.delegate.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        }),
      ) as never,
    );
  }
}
