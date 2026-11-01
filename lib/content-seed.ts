/**
 * File: lib/content-seed.ts
 * A DOCUMENT WHOSE FIRST DRAFT SHIPS IN THE REPOSITORY — put into the editor, once, by itself.
 *
 * ── WHAT THE OWNER ASKED FOR (2026-11-01) ───────────────────────────────────────────────────────
 * "Seed my v1 terms text into Engine Room → Content as an unpublished draft (affiliate-terms), on
 * production at deploy, so I can see and edit it there. Publishing stays a separate step."
 *
 * ── WHY IT IS NOT DONE AT BUILD, WHICH IS WHAT "AT DEPLOY" SOUNDS LIKE ──────────────────────────
 * A build writing to the database would write from a build container, on EVERY build including
 * every preview, against whatever DATABASE_URL that environment holds — and dev and production
 * share one database here. A deploy step that writes rows is a deploy that can half-write them.
 *
 * So the draft appears the first time the owner OPENS Engine Room → Content, from the file that
 * shipped with the deploy. That is the same shape as getProgrammeSettings, which creates its
 * singleton from the schema's defaults on first read rather than defaulting in code: the row is
 * made by the first person who needs it, inside a request that is already authenticated.
 *
 * ── IT FIRES ONCE, AND A DISCARD STAYS DISCARDED ────────────────────────────────────────────────
 * Two guards, because they answer different questions:
 *   • ANY row for (slug, country) — a draft to edit or a published version — means there is nothing
 *     to seed, and overwriting either would be the editor's job and not ours.
 *   • A PRIOR SEED AUDIT ROW means this has already happened, even if nothing is there now. That is
 *     the case the first guard cannot see: discarding the draft deletes the row, and without this
 *     the seed would put it back on the next page load, for ever. A deletion record cannot reference
 *     its subject — the audit row IS the evidence, and it outlives what it is about.
 *
 * ── IT NEVER PUBLISHES, AND IT CANNOT ──────────────────────────────────────────────────────────
 * status 'draft', version the DRAFT sentinel, and no effective_from. The body goes in UNBAKED, with
 * its `{{totalReward}}` placeholders intact, exactly as scripts/publish-affiliate-terms.mjs --write
 * leaves it: the draft is the editable thing, and baking it here would mean the owner's next edit
 * started from substituted text and lost the placeholders for ever. Publishing is what bakes them,
 * refuses an unresolved one, and spends a version — all of it the owner's separate step.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { DRAFT, type DocType } from '@/lib/content';
import { AFFILIATE_TERMS_SLUG } from '@/lib/affiliate-terms';

type Db = PrismaClient | Prisma.TransactionClient;

export type SeedableDraft = {
  slug: string;
  country: string;
  type: DocType;
  /** Relative to the repository root, and traced into the serverless function by next.config.js. */
  file: string;
  /** Used only if the file carries no `# heading` — two spellings of a legal document's name is one
   * of them being wrong on somebody's screen, so the file's own H1 wins. */
  fallbackTitle: string;
};

/**
 * THE REGISTRY — a list, not a rule about every document. A garage's privacy notice has no file in
 * this repository and must not acquire one by a pattern match; adding a line here is a decision.
 */
export const SEEDABLE_DRAFTS: readonly SeedableDraft[] = [
  {
    slug: AFFILIATE_TERMS_SLUG,
    country: 'GB',
    type: 'legal',
    file: 'content/affiliate-terms.md',
    fallbackTitle: 'GreaseDesk Affiliate Terms',
  },
];

/** The audit action, read by the guard as well as written by it — one spelling, one home. */
export const SEED_AUDIT_ACTION = 'document.seeded';

/** The key both the audit row and its guard use. Matches pages/api/superadmin/content's own. */
export const seedTarget = (slug: string, country: string): string => `${slug}/${country}`;

/** The document's name, from its own first heading. */
export function titleFromMarkdown(body: string, fallback: string): string {
  return (/^#\s+(.+)$/m.exec(String(body ?? '')) ?? [])[1]?.trim() || fallback;
}

export type SeedOutcome = { slug: string; country: string; result: 'seeded' | 'exists' | 'already_seeded' | 'no_file' };

/** The pair every outcome carries, so each `out.push` says the same two things the same way. */
const key = (d: SeedableDraft) => ({ slug: d.slug, country: d.country });

/**
 * PUT EVERY MISSING FIRST DRAFT IN. Returns what it did for each registered document, so a caller
 * can log it — and so a gate can assert the SECOND call reports 'already_seeded' rather than
 * writing again, which is the only way to prove the once-ness.
 *
 * `readFile` is injected so a gate can drive the whole path without the filesystem, and so this
 * module has no import of node:fs at module scope — a server-only import reachable from a page's
 * graph is how a client bundle acquires a 500.
 */
export async function seedContentDrafts(
  db: Db,
  readFile: (relativePath: string) => string | null,
  drafts: readonly SeedableDraft[] = SEEDABLE_DRAFTS,
): Promise<SeedOutcome[]> {
  const out: SeedOutcome[] = [];
  for (const d of drafts) {
    const existing = await (db as any).document.findFirst({
      where: { slug: d.slug, country_code: d.country },
      select: { id: true },
    });
    if (existing) { out.push({ ...key(d), result: 'exists' }); continue; }

    const seededBefore = await (db as any).superAdminAudit.findFirst({
      where: { action: SEED_AUDIT_ACTION, target_name_snapshot: seedTarget(d.slug, d.country) },
      select: { id: true },
    });
    if (seededBefore) { out.push({ ...key(d), result: 'already_seeded' }); continue; }

    const body = readFile(d.file);
    // NO FILE IS REPORTED, NOT THROWN. This runs inside the page that lists documents; a missing
    // file must leave that list working. The caller logs it, and the Content screen is unharmed.
    if (body == null || body.trim() === '') { out.push({ ...key(d), result: 'no_file' }); continue; }

    try {
      await (db as any).document.create({
        data: {
          slug: d.slug,
          title: titleFromMarkdown(body, d.fallbackTitle),
          type: d.type,
          country_code: d.country,
          body,
          version: DRAFT,
          status: 'draft',
          // NO created_by. The row was not made by an operator — it was made by the deploy, and
          // SuperAdminAudit's own note is the rule being followed: a sentinel actor id would be a
          // lie in the one place whose job is saying who did what.
          created_by: null,
        },
      });
    } catch (e: any) {
      // THE UNIQUE INDEX IS THE REAL GUARD. Two tabs opening the Content screen at the same moment
      // both read no row and both try; (slug, country, version) is unique, so the second one loses
      // and that is a draft that EXISTS rather than an error to show somebody.
      if (e?.code === 'P2002') { out.push({ ...key(d), result: 'exists' }); continue; }
      throw e;
    }
    await (db as any).superAdminAudit.create({
      data: {
        operator_user_id: null, // the platform acted — see above
        action: SEED_AUDIT_ACTION,
        target_name_snapshot: seedTarget(d.slug, d.country),
        detail: { type: d.type, file: d.file, characters: body.length },
      },
    });
    out.push({ ...key(d), result: 'seeded' });
  }
  return out;
}

