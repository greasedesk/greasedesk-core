/**
 * File: lib/content-publish.ts
 * PUBLISHING A DRAFT — the decision and the write, in one place.
 *
 * ── WHY IT MOVED OUT OF THE API HANDLER ─────────────────────────────────────────────────────────
 * It lived inside pages/api/superadmin/content.ts, which was fine while the Engine Room button was
 * the only way to publish. Baking the figures in (owner, 2026-10-31) gave the publish a STEP THAT
 * MATTERS — substitute, then refuse a placeholder, then compare for a no-op — and a second caller
 * that re-implemented that order would get it subtly wrong: bake after the identical check and a
 * settings-only change is refused as a no-op; skip the refusal and an immutable legal version goes
 * out with `{{totalReward}}` printed in it.
 *
 * So the order is written down once, here. The handler keeps what belongs to it — who may publish,
 * which countries they may touch, and the audit row — and calls this for what happens.
 *
 * ── THE ORDER, AND WHY IT IS THIS ORDER ─────────────────────────────────────────────────────────
 *   1. It must be a draft. A published version is immutable; there is nothing to publish twice.
 *   2. A legal document must have an effective date. A page may default to now.
 *   3. BAKE the figures, if this slug takes them.
 *   4. REFUSE an unresolved placeholder. After step 6 it could never be corrected.
 *   5. REFUSE a publish identical to the version it would supersede — compared on the BAKED body,
 *      because that is what gets stored. Comparing the draft would refuse the one case the owner
 *      explicitly wants: prose unchanged, a setting changed, so a new version must go out.
 *   6. Mint the stamp and write. One update: body, version, status, published_at, effective_from.
 */
import type { PrismaClient } from '@prisma/client';
import { resolvePublished, nextVersionStamp, refuseIdenticalPublish } from '@/lib/content';
import { FIGURE_BAKED_SLUGS, bakeFigures, refuseUnbaked, termsFigures } from '@/lib/affiliate-terms';

export type PublishRefusal = { ok: false; code: string; status: number; message: string };
export type PublishResult =
  | { ok: true; version: string; slug: string; country: string; type: string; effectiveFrom: Date; baked: boolean }
  | PublishRefusal;

/**
 * Figures for a slug that takes them, or null. Its own function so a PREVIEW can show the editor
 * exactly what a publish would substitute, without publishing to find out.
 */
export async function figuresForSlug(db: PrismaClient, slug: string) {
  if (!FIGURE_BAKED_SLUGS.has(slug)) return null;
  return termsFigures(db);
}

export async function publishDraft(
  db: PrismaClient,
  args: { id: string; effectiveFrom?: string | null },
): Promise<PublishResult> {
  const doc = await db.document.findUnique({ where: { id: String(args.id ?? '') } });
  if (!doc) return { ok: false, code: 'not_found', status: 404, message: 'Document not found.' };
  if (doc.status !== 'draft') {
    return {
      ok: false, code: 'immutable', status: 409,
      message: 'That version is already published and is immutable. Create a new version instead.',
    };
  }

  const given = args.effectiveFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(args.effectiveFrom))
    ? new Date(`${String(args.effectiveFrom)}T00:00:00.000Z`)
    : null;
  if (doc.type === 'legal' && !given) {
    return {
      ok: false, code: 'needs_effective_from', status: 400,
      message: 'A legal document needs an effective date (YYYY-MM-DD) — the published version becomes immutable.',
    };
  }
  const effectiveFrom = given ?? new Date();

  // ── 3 and 4: BAKE, THEN REFUSE A PLACEHOLDER ────────────────────────────────────────────────
  const figures = await figuresForSlug(db, doc.slug);
  let body = doc.body;
  let baked = false;
  if (figures) {
    const r = bakeFigures(doc.body, figures);
    const unbaked = refuseUnbaked(r.unfilled);
    if (unbaked) return { ok: false, code: 'unresolved_figure', status: 400, message: unbaked };
    body = r.body;
    baked = true;
  }

  // ── 5: THE NO-OP CHECK, ON WHAT WOULD ACTUALLY BE STORED ────────────────────────────────────
  const superseded = await resolvePublished(db, doc.slug, doc.country_code);
  const identical = refuseIdenticalPublish(body, superseded?.body ?? null, superseded?.version ?? null);
  if (identical) return { ok: false, code: identical.code, status: 409, message: identical.message };

  const version = await nextVersionStamp(db, doc.slug, doc.country_code, effectiveFrom);
  await db.document.update({
    where: { id: doc.id },
    data: { body, version, status: 'published', published_at: new Date(), effective_from: effectiveFrom },
  });
  return { ok: true, version, slug: doc.slug, country: doc.country_code, type: doc.type, effectiveFrom, baked };
}
