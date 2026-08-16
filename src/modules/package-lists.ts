import { prisma } from '../lib/prisma.js';
import type { ListKind } from '@prisma/client';

export const LIST_KINDS: ListKind[] = [
  'INCLUSION',
  'EXCLUSION',
  'THING_TO_CARRY',
  'MAJOR_ACTIVITY',
  'TERM',
];

/**
 * Inclusions, exclusions, things-to-carry, activities and terms used to live in
 * a single MorePackageDetails.json shared by every package. That behaviour is
 * preserved: rows with `packageId = null` are GLOBAL DEFAULTS.
 *
 * Resolution rule, per kind: if a package defines any items of that kind, they
 * replace the defaults for that kind only. Otherwise the defaults apply. So an
 * editor can override just the exclusions on one package without having to
 * re-enter the other four lists.
 */

interface CachedGlobals {
  value: { kind: ListKind; text: string }[];
  expiresAt: number;
}

let cache: CachedGlobals | null = null;
const CACHE_TTL_MS = 30_000;

async function getGlobalItems(): Promise<{ kind: ListKind; text: string }[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const rows = await prisma.packageListItem.findMany({
    where: { packageId: null },
    orderBy: { sortOrder: 'asc' },
    select: { kind: true, text: true },
  });

  cache = { value: rows, expiresAt: now + CACHE_TTL_MS };
  return rows;
}

/** Called after any write to the global defaults so readers see them at once. */
export function invalidateGlobalListCache(): void {
  cache = null;
}

export type ResolvedLists = Record<ListKind, string[]>;

/**
 * Public-read transform: collapses raw listItems into a ready-to-render `lists`
 * object so the website never has to know about the fallback rule.
 */
export async function resolvePackageLists(
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const own = (row.listItems ?? []) as { kind: ListKind; text: string }[];
  const globals = await getGlobalItems();

  const lists = {} as ResolvedLists;
  for (const kind of LIST_KINDS) {
    const ownForKind = own.filter((i) => i.kind === kind);
    const source = ownForKind.length > 0 ? ownForKind : globals.filter((g) => g.kind === kind);
    lists[kind] = source.map((i) => i.text);
  }

  return { ...row, lists };
}
