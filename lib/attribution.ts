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

type Db = PrismaClient | Prisma.TransactionClient;

// A ref-param attribution: the Rep is the party, as the REFERRER, taking the whole payment.
const PARTY_REP = 'rep';
const ROLE_REFERRER = 'referrer';
const FULL_SHARE_BP = 10000;
const SOURCE_REF = 'ref_param';

export type ResolveResult =
  | { status: 'resolved'; created: boolean; repId: string; attributionId: string }
  | { status: 'no_ref' }                     // group carried no ref — nothing to resolve
  | { status: 'no_rep'; ref: string }        // ref intact, no Rep yet — deferred until one exists
  | { status: 'conflict'; reason: string };  // group already has a different active attribution

/**
 * Resolve ONE group's captured ref into an attribution. Matches a Rep by exact ref_code (ref_code is
 * @unique and case-sensitive — a captured 'TESTREP' matches Rep 'TESTREP', not 'testrep'). On a match
 * with no existing active attribution, writes the rep at 100% effective from the group's signup date.
 * NEVER touches Group.signup_ref.
 */
export async function resolveAttribution(db: Db, groupId: string, opts: { createdBy?: string | null } = {}): Promise<ResolveResult> {
  const group = await (db as any).group.findUnique({ where: { id: groupId }, select: { id: true, signup_ref: true, created_at: true } });
  if (!group) throw new Error(`ATTRIBUTION: group ${groupId} not found`);
  const ref = (group.signup_ref ?? '').trim();
  if (!ref) return { status: 'no_ref' };

  const rep = await (db as any).rep.findUnique({ where: { ref_code: ref }, select: { id: true } });
  if (!rep) return { status: 'no_rep', ref }; // deferred: the ref survives, resolution retries when a Rep lands

  const active = await (db as any).tenantAttribution.findMany({
    where: { group_id: group.id, ended_at: null }, select: { id: true, party_type: true, party_id: true },
  });
  const mine = active.find((a: any) => a.party_type === PARTY_REP && a.party_id === rep.id);
  if (mine) return { status: 'resolved', created: false, repId: rep.id, attributionId: mine.id }; // idempotent no-op
  if (active.length > 0) {
    return { status: 'conflict', reason: `group already has ${active.length} active attribution(s); a 100% ref attribution would break the Σ=10000 share invariant — resolve by hand` };
  }

  const row = await (db as any).tenantAttribution.create({
    data: {
      group_id: group.id, party_type: PARTY_REP, party_id: rep.id, role: ROLE_REFERRER,
      share_bp: FULL_SHARE_BP, effective_from: group.created_at, ended_at: null, source: SOURCE_REF,
      created_by: opts.createdBy ?? null,
    },
    select: { id: true },
  });
  return { status: 'resolved', created: true, repId: rep.id, attributionId: row.id };
}

/**
 * DEFERRED trigger: a Rep has just been created (or reactivated) — resolve any groups that already
 * carried this Rep's ref_code and were waiting for them. This is the path that makes signup-before-Rep
 * work: the raw refs sat intact, and now they resolve.
 */
export async function resolveAttributionsForRep(db: Db, repId: string, opts: { createdBy?: string | null } = {}): Promise<{ groups: number; created: number }> {
  const rep = await (db as any).rep.findUnique({ where: { id: repId }, select: { ref_code: true } });
  if (!rep) throw new Error(`ATTRIBUTION: rep ${repId} not found`);
  const groups = await (db as any).group.findMany({ where: { signup_ref: rep.ref_code }, select: { id: true } });
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
