import type { BaseRepository, Row } from './base.repository.js';
import { conflict, notFound } from '../lib/errors.js';
import { ensureUniqueSlug, toSlug } from '../lib/slug.js';
import { sanitizeRichText, stripHtml } from '../lib/sanitize.js';
import { flattenImageFields } from '../lib/images.js';

/**
 * BUSINESS LOGIC LAYER.
 *
 * Owns every rule that is true regardless of how the request arrived — slug
 * generation and uniqueness, HTML sanitisation, what "published" means, how
 * search works, what a page of results is.
 *
 * It knows nothing about HTTP: no request, no reply, no status codes. That
 * makes it directly reusable from a CLI task, a cron job, or a queue worker,
 * and unit-testable without starting a server.
 *
 * Subclass it when a resource has real domain logic of its own (see
 * PackageService); otherwise use it as-is with a config.
 */

export interface ServiceConfig {
  /** Human-readable name used in error messages, e.g. "Package". */
  singular: string;
  hasSlug?: boolean;
  hasPublished?: boolean;
  hasSortOrder?: boolean;
  /** Field a slug is derived from when the caller supplies none. */
  slugFrom?: string;
  /** Sanitised as rich HTML on write. */
  richTextFields?: string[];
  /** Stripped of all markup on write. */
  plainTextFields?: string[];
  /** Fields a `q` search matches, case-insensitively. */
  searchFields?: string[];
  /** Image relations to flatten into URL strings on public reads. */
  imageFields?: string[];
  defaultOrderBy?: Record<string, unknown>[];
}

export interface ListParams {
  page: number;
  perPage: number;
  q?: string;
  /** Admin listings pass this to filter drafts; public listings never do. */
  published?: boolean;
  /** Public callers force published-only regardless of `published`. */
  publicOnly?: boolean;
}

export interface PagedResult {
  items: Row[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export class BaseService {
  constructor(
    protected readonly repo: BaseRepository,
    protected readonly config: ServiceConfig,
  ) {}

  protected get orderBy(): Record<string, unknown>[] {
    if (this.config.defaultOrderBy) return this.config.defaultOrderBy;
    return this.config.hasSortOrder
      ? [{ sortOrder: 'asc' }, { id: 'asc' }]
      : [{ id: 'asc' }];
  }

  protected buildWhere(params: ListParams): Record<string, unknown> {
    const where: Record<string, unknown> = {};

    if (params.publicOnly && this.config.hasPublished) {
      where.published = true;
    } else if (params.published !== undefined) {
      where.published = params.published;
    }

    const fields = this.config.searchFields ?? [];
    if (params.q && fields.length > 0) {
      where.OR = fields.map((field) => ({
        [field]: { contains: params.q, mode: 'insensitive' },
      }));
    }

    return where;
  }

  /**
   * Shapes a row for PUBLIC consumption. The base implementation is a no-op;
   * override it to hand the website data it can render directly instead of
   * making it reimplement business rules. Admin reads never go through it,
   * because an editor must see exactly what is stored.
   */
  protected async transformForPublic(row: Row): Promise<Row> {
    return flattenImageFields(row, this.config.imageFields ?? []);
  }

  async list(params: ListParams): Promise<PagedResult> {
    const where = this.buildWhere(params);

    const { rows, total } = await this.repo.findManyWithCount({
      where,
      orderBy: this.orderBy,
      skip: (params.page - 1) * params.perPage,
      take: params.perPage,
    });

    const items = params.publicOnly
      ? await Promise.all(rows.map((row) => this.transformForPublic(row)))
      : rows;

    return {
      items,
      total,
      page: params.page,
      perPage: params.perPage,
      totalPages: Math.ceil(total / params.perPage) || 1,
    };
  }

  async getBySlug(slug: string, publicOnly = true): Promise<Row> {
    const extra = publicOnly && this.config.hasPublished ? { published: true } : undefined;
    const row = await this.repo.findBySlug(slug, extra);

    if (!row) throw notFound(this.config.singular);
    return publicOnly ? this.transformForPublic(row) : row;
  }

  async getById(id: number): Promise<Row> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound(this.config.singular);
    return row;
  }

  async create(input: Row): Promise<Row> {
    return this.repo.create(await this.prepare(input));
  }

  async update(id: number, input: Row): Promise<Row> {
    if (!(await this.repo.exists(id))) throw notFound(this.config.singular);
    return this.repo.update(id, await this.prepare(input, id));
  }

  /** Returns the row as it was before deletion, so callers can revalidate its URL. */
  async remove(id: number): Promise<Row> {
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound(this.config.singular);

    try {
      await this.repo.delete(id);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2003') {
        throw conflict(
          `This ${this.config.singular.toLowerCase()} is still referenced by other records and cannot be deleted.`,
        );
      }
      throw error;
    }

    return existing;
  }

  async reorder(items: { id: number; sortOrder: number }[]): Promise<number> {
    await this.repo.reorder(items);
    return items.length;
  }

  /**
   * Everything that must happen to input before it reaches the database.
   * Shared by create and update so the two can never drift apart.
   */
  protected async prepare(input: Row, existingId?: number): Promise<Row> {
    const data: Row = { ...input };

    // Sanitising on WRITE means the database can never hold a stored-XSS
    // payload, so every reader is safe without remembering to sanitise.
    for (const field of this.config.richTextFields ?? []) {
      if (typeof data[field] === 'string') {
        data[field] = sanitizeRichText(data[field] as string);
      }
    }

    for (const field of this.config.plainTextFields ?? []) {
      if (typeof data[field] === 'string') {
        data[field] = stripHtml(data[field] as string);
      }
    }

    if (this.config.hasSlug) {
      const supplied = typeof data.slug === 'string' ? data.slug.trim() : '';
      const source =
        supplied ||
        (this.config.slugFrom && typeof data[this.config.slugFrom] === 'string'
          ? (data[this.config.slugFrom] as string)
          : '');

      if (source) {
        data.slug = await ensureUniqueSlug({
          desired: toSlug(source),
          excludeId: existingId,
          findExisting: (slug) => this.repo.findIdBySlug(slug),
        });
      } else {
        // An update that renames nothing must not silently change a live URL.
        delete data.slug;
      }
    }

    return data;
  }
}
