/**
 * File: lib/attribution.ts
 * ATTRIBUTION RESOLUTION — the chokepoint that turns the captured `?ref=` string into the
 * TenantAttribution join the commission engine (lib/commission) reads. It closes the spine:
 *   ?ref=code → gd_ref cookie → Group.signup_ref (capture, built 18 Jul) → THIS → TenantAttribution →
 *   computeCommission.
 *
 * THE IRREVERSIBILITY RULE: Group.signup_ref is the CAPTURED TRUTH — who referred this tenant. It is
 * never dropped or overwritten by resolution. The TenantAttribution row is DERIVED from it; the ref is
 * the source. So a signup that arrives before its Rep exists loses nothing — the ref sits intact until
 * a Rep with that ref_code appears, and resolution is simply re-run (deferred path).
 *
 * IDEMPOTENCY: re-running never duplicates. An existing active rep-attribution for the same
 * (group, rep) is a no-op. And because a ref attribution is a 100% share, we refuse to add one when
 * the group already carries a DIFFERENT active attribution — that would break the engine's Σ=10000
 * invariant. There is no wall-clock here: effective_from is the group's signup date, not `now`.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { sanitiseRef } from '@/lib/consent';

type Db = PrismaClient | Prisma.TransactionClient;

// A ref-param attribution: the matched party is the REFERRER, taking the whole payment.
const PARTY_REP = 'rep';
const PARTY_AFFILIATE = 'affiliate';
const ROLE_REFERRER = 'referrer';
const FULL_SHARE_BP = 10000;
const SOURCE_REF = 'ref_param';

/** Who a ref code resolved to. Every non-match is NAMED, because they need different messages:
 *  "we don't know that code" and "that affiliate is suspended" are not the same thing to say. */
export type RefMatch =
  | { status: 'none' }                                              // blank, or no such code
  | { status: 'ambiguous'; codes: string[] }                        // two codes differing only by case
  | { status: 'suspended'; partyId: string; refCode: string }       // real, but not taking new signups
  | {
      status: 'found';
      partyId: string;
      partyType: typeof PARTY_REP | typeof PARTY_AFFILIATE;
      refCode: string;
      email: string | null;
      phone: string | null;
      name: string | null;
    };

const SELECT_PARTY = {
  id: true, party_type: true, ref_code: true, email: true, phone: true, name: true,
  trading_name: true, suspended_at: true,
} as const;

const asMatch = (r: any): RefMatch => (
  r.suspended_at
    ? { status: 'suspended', partyId: r.id, refCode: r.ref_code }
    : {
        status: 'found', partyId: r.id, partyType: r.party_type, refCode: r.ref_code,
        email: r.email ?? null, phone: r.phone ?? null, name: r.trading_name ?? r.name ?? null,
      }
);

/**
 * TURN A TYPED-OR-CAPTURED CODE INTO A PARTY, or say exactly why it did not.
 *
 * ── CASE: AFFILIATES INSENSITIVE, REPS EXACT (owner, 2026-10-28) ───────────────────────────────
 * An affiliate code is read off a business card, a bio link or a forwarded message and retyped by
 * someone who was never shown the capitals, so GBJONES and gbjones are one code. A rep code is
 * issued and used by us, `ref_code` is @unique and Postgres uniqueness is case-SENSITIVE, so
 * 'ABC' and 'abc' can both exist today and folding them would be a guess about which was meant.
 * Rep matching is therefore left exactly as it was, pending a production check for codes that
 * differ only by case — see scripts/check-ref-code-case.mjs. When that check comes back empty the
 * `party_type` filter below is the single line to drop.
 *
 * ── AND IT REFUSES RATHER THAN PICKING ─────────────────────────────────────────────────────────
 * Case-insensitive matching can legitimately return two rows. Taking the first would pay the wrong
 * person on a difference nobody can see, so `ambiguous` is its own answer and attributes nothing.
 */
export async function findPartyByRefCode(db: Db, raw: unknown): Promise<RefMatch> {
  const code = sanitiseRef(raw); // trims, strips to [A-Za-z0-9._-], caps 64 — the same clean as capture
  if (!code) return { status: 'none' };

  // EXACT FIRST, and it settles the rep case entirely: a rep code only ever matches as typed.
  const exact = await (db as any).rep.findUnique({ where: { ref_code: code }, select: SELECT_PARTY });
  if (exact) return asMatch(exact);

  const folded = await (db as any).rep.findMany({
    where: { party_type: PARTY_AFFILIATE, ref_code: { equals: code, mode: 'insensitive' } },
    select: SELECT_PARTY,
  });
  if (folded.length === 0) return { status: 'none' };
  if (folded.length > 1) return { status: 'ambiguous', codes: folded.map((r: any) => r.ref_code).sort() };
  return asMatch(folded[0]);
}

export type ResolveResult =
  | { status: 'resolved'; created: boolean; repId: string; attributionId: string }
  | { status: 'no_ref' }                     // group carried no ref — nothing to resolve
  | { status: 'no_rep'; ref: string }        // ref intact, no Rep yet — deferred until one exists
  | { status: 'suspended'; ref: string }     // the code is real; the party is not taking new signups
  | { status: 'ambiguous'; ref: string; codes: string[] } // two codes differ only by case — refuse
  | { status: 'conflict'; reason: string };  // group already has a different active attribution

/**
 * WRITE THE ATTRIBUTION, or say why not. The single writer of a ref-param TenantAttribution, so
 * the one-active-referrer rule and the Σ=10000 invariant are enforced in one place whether the row
 * is being written at signup (inside the garage's own transaction) or resolved afterwards.
 */
export async function attributeGroup(
  db: Db,
  args: { groupId: string; partyId: string; partyType: string; effectiveFrom: Date; createdBy?: string | null },
): Promise<{ created: boolean; attributionId: string } | { conflict: string }> {
  const active = await (db as any).tenantAttribution.findMany({
    where: { group_id: args.groupId, ended_at: null }, select: { id: true, party_type: true, party_id: true },
  });
  const mine = active.find((a: any) => a.party_id === args.partyId && a.party_type === args.partyType);
  if (mine) return { created: false, attributionId: mine.id }; // idempotent no-op
  if (active.length > 0) {
    return { conflict: `group already has ${active.length} active attribution(s); a 100% ref attribution would break the Σ=10000 share invariant — resolve by hand` };
  }
  const row = await (db as any).tenantAttribution.create({
    data: {
      group_id: args.groupId, party_type: args.partyType, party_id: args.partyId, role: ROLE_REFERRER,
      share_bp: FULL_SHARE_BP, effective_from: args.effectiveFrom, ended_at: null, source: SOURCE_REF,
      created_by: args.createdBy ?? null,
    },
    select: { id: true },
  });
  return { created: true, attributionId: row.id };
}

/**
 * Resolve ONE group's captured ref into an attribution, through findPartyByRefCode — so a rep code
 * still matches only as typed, while an affiliate code matches whatever case it was retyped in. On a
 * match with no existing active attribution, writes the party at 100% effective from the group's
 * signup date. NEVER touches Group.signup_ref.
 */
export async function resolveAttribution(db: Db, groupId: string, opts: { createdBy?: string | null } = {}): Promise<ResolveResult> {
  const group = await (db as any).group.findUnique({ where: { id: groupId }, select: { id: true, signup_ref: true, created_at: true } });
  if (!group) throw new Error(`ATTRIBUTION: group ${groupId} not found`);
  const ref = (group.signup_ref ?? '').trim();
  if (!ref) return { status: 'no_ref' };

  const match = await findPartyByRefCode(db, ref);
  // deferred: the ref survives, resolution retries when a party with that code lands
  if (match.status === 'none') return { status: 'no_rep', ref };
  if (match.status === 'ambiguous') return { status: 'ambiguous', ref, codes: match.codes };
  if (match.status === 'suspended') return { status: 'suspended', ref };

  // THE PARTY'S OWN TYPE, not a constant. This wrote 'rep' for every attribution, which was true
  // while reps were the only partners; an affiliate recorded as a rep would be looked for by
  // lib/commission's reseller taper and paid by the wrong pay run.
  const written = await attributeGroup(db, {
    groupId: group.id, partyId: match.partyId, partyType: match.partyType,
    effectiveFrom: group.created_at, createdBy: opts.createdBy ?? null,
  });
  if ('conflict' in written) return { status: 'conflict', reason: written.conflict };
  return { status: 'resolved', created: written.created, repId: match.partyId, attributionId: written.attributionId };
}

/**
 * DEFERRED trigger: a Rep has just been created (or reactivated) — resolve any groups that already
 * carried this Rep's ref_code and were waiting for them. This is the path that makes signup-before-Rep
 * work: the raw refs sat intact, and now they resolve.
 */
export async function resolveAttributionsForRep(db: Db, repId: string, opts: { createdBy?: string | null } = {}): Promise<{ groups: number; created: number }> {
  const rep = await (db as any).rep.findUnique({ where: { id: repId }, select: { ref_code: true, party_type: true } });
  if (!rep) throw new Error(`ATTRIBUTION: rep ${repId} not found`);
  // MATCHED THE SAME WAY findPartyByRefCode MATCHES, or the deferred path quietly misses exactly
  // the signups the live path would have caught: a garage that typed `gbjones` waits forever for
  // an affiliate whose code is GBJONES.
  const where = rep.party_type === PARTY_AFFILIATE
    ? { signup_ref: { equals: rep.ref_code, mode: 'insensitive' as const } }
    : { signup_ref: rep.ref_code };
  const groups = await (db as any).group.findMany({ where, select: { id: true } });
  let created = 0;
  for (const g of groups) { const r = await resolveAttribution(db, g.id, opts); if (r.status === 'resolved' && r.created) created++; }
  return { groups: groups.length, created };
}

/**
 * Operator-triggered sweep (Engine Room): resolve every group that carried a ref but has no active
 * attribution yet. Safe to run any time — no-ref and no-rep groups are skipped, matches are idempotent.
 */
export async function resolveAllPending(db: Db, opts: { createdBy?: string | null } = {}): Promise<{ scanned: number; created: number }> {
  const groups = await (db as any).group.findMany({ where: { signup_ref: { not: null } }, select: { id: true } });
  let created = 0;
  for (const g of groups) { const r = await resolveAttribution(db, g.id, opts); if (r.status === 'resolved' && r.created) created++; }
  return { scanned: groups.length, created };
}
