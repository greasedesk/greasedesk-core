/**
 * File: lib/content.ts
 * THE content chokepoint — resolution, versioning rules, and the freeze discipline for the Document
 * table. One table, two behaviours: `legal` freezes an immutable version at publish; `page` lets the
 * latest published version win. Neither ever mutates a published row — corrections publish a NEW version.
 * Public rendering and the Engine Room editor both read/resolve through here.
 */
import type { PrismaClient, Prisma } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type DocType = 'legal' | 'page';
export const DOC_TYPES: DocType[] = ['legal', 'page'];
export const DRAFT = 'draft'; // the reserved version sentinel for the single work-in-progress row

export const isDocType = (t: unknown): t is DocType => t === 'legal' || t === 'page';
/** Editing a `legal` doc is Owner-only; a `page` is Owner + Country Manager. Support edits neither. */
export function canEditType(role: string, type: DocType): boolean {
  return type === 'legal' ? role === 'owner' : role === 'owner' || role === 'country_manager';
}
/** Slug: lower-kebab, alnum + hyphen, capped — a URL segment, never free text. */
export function sanitiseSlug(raw: string): string {
  return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * The CURRENT published version of (slug, country): exact-country match, else GB fallback, taking the
 * latest published_at. Returns null when nothing is published (→ the public route 404s; a draft is
 * never rendered publicly).
 */
export async function resolvePublished(db: Db, slug: string, country = 'GB') {
  const pick = (cc: string) => (db as any).document.findFirst({
    where: { slug, country_code: cc, status: 'published' }, orderBy: { published_at: 'desc' },
  });
  return (await pick(country)) ?? (country !== 'GB' ? await pick('GB') : null);
}

/** Published version history for a doc key, newest first (what changed, who published, when). */
export function publishedHistory(db: Db, slug: string, country: string) {
  return (db as any).document.findMany({ where: { slug, country_code: country, status: 'published' }, orderBy: { published_at: 'desc' } });
}

/** The single WIP draft for a doc key, if one exists (the unique index guarantees at most one). */
export function currentDraft(db: Db, slug: string, country: string) {
  return (db as any).document.findUnique({ where: { slug_country_code_version: { slug, country_code: country, version: DRAFT } } });
}

/**
 * A collision-safe published version STAMP derived from the effective date ('YYYY-MM-DD', then -2, -3…).
 * A string (not an int) so an existing consent record's version — e.g. '2026-07-21' — resolves to a real
 * version. Never returns the reserved 'draft' sentinel.
 */
export async function nextVersionStamp(db: Db, slug: string, country: string, effectiveFrom: Date): Promise<string> {
  const base = effectiveFrom.toISOString().slice(0, 10);
  let stamp = base, n = 1;
  while (stamp === DRAFT || (await (db as any).document.findUnique({ where: { slug_country_code_version: { slug, country_code: country, version: stamp } } }))) {
    n += 1; stamp = `${base}-${n}`;
  }
  return stamp;
}
