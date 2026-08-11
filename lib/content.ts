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

/**
 * Every slug with a published version, and when it last changed — the PUBLIC surface of the content
 * system, as a set rather than one lookup at a time.
 *
 * Exists because the sitemap listed five hardcoded paths, so /cookies, /privacy and /terms were
 * invisible to search: the whole point of the content system is that a document gets a URL with no
 * deploy, and a hardcoded list quietly undoes that for the next document as well. DISTINCT slugs,
 * because a doc key has many published versions and the sitemap wants one URL each.
 */
export async function publishedSlugs(db: Db, country = 'GB'): Promise<Array<{ slug: string; lastModified: Date | null }>> {
  const rows = (await (db as any).document.findMany({
    where: { status: 'published', country_code: country },
    select: { slug: true, published_at: true },
    orderBy: { published_at: 'desc' },
  })) as Array<{ slug: string; published_at: Date | null }>;
  const seen = new Map<string, Date | null>();
  for (const r of rows) if (r.slug && !seen.has(r.slug)) seen.set(r.slug, r.published_at); // newest first
  return [...seen.entries()].map(([slug, lastModified]) => ({ slug, lastModified })).sort((a, b) => a.slug.localeCompare(b.slug));
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

/**
 * ── PUBLISHING SOMETHING IDENTICAL IS ALWAYS A MISTAKE ──────────────────────────────────────────
 * A legal version is immutable and its stamp is spent forever, so a publish that changes not one
 * byte burns a version number and re-dates the OLD text — which reads to a customer as a fresh
 * commitment to wording you were trying to replace.
 *
 * This has fired at least three times in this system's short life: the two `terms` publishes on
 * 2026-08-07 and the `privacy` publish on 2026-07-30, all byte-identical to what they superseded.
 * The cause each time was the editor publishing a draft whose body had never been saved, so the
 * fork's seeded text went out under a new date. The editor is fixed; this is the backstop, because
 * the next cause will be something else.
 *
 * NULL = go ahead. Nothing published yet (a first version) has nothing to be identical TO.
 */
export type IdenticalPublishRefusal = { code: 'identical_to_published'; message: string };

export function refuseIdenticalPublish(
  draftBody: string | null | undefined,
  publishedBody: string | null | undefined,
  publishedVersion?: string | null,
): IdenticalPublishRefusal | null {
  if (publishedBody == null) return null;                 // nothing to supersede — a first publish
  if ((draftBody ?? '') !== publishedBody) return null;   // it differs; that is the whole point
  return {
    code: 'identical_to_published',
    message:
      `This draft is byte-for-byte identical to the published version${publishedVersion ? ` (${publishedVersion})` : ''}, ` +
      `so publishing would spend a new version number and re-date the same text. ` +
      `If you edited the body, press "Save draft" first — an unsaved edit is not in the draft. ` +
      `If you meant only to change the effective date, that still needs a real change to the wording.`,
  };
}

