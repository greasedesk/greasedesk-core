/**
 * File: lib/commission.ts
 * THE commission engine — the money spine (platform layer 2). ONE calculation every financial
 * surface reads: the rep's earned dashboard, the Engine Room retained-revenue forecast, the payout run, the
 * clawback. No surface computes commission independently. Divergent maths between the rep view and
 * the operator view is the failure mode this file exists to prevent.
 *
 * BUILT DORMANT — no live payments. Every rule is proven synthetically against a FIXED CLOCK and a
 * synthetic payment/refund ledger. Two seams make that possible and are load-bearing:
 *   1. NO wall-clock. Callers pass explicit dates; nothing here reads Date.now()/new Date().
 *   2. Payments/refunds come from an injected PaymentLedger, never a direct Stripe import — the prod
 *      ledger reads Stripe/GroupBilling, the test ledger returns synthetic rows.
 *
 * RULES (pinned by the fixed-clock plan):
 *   • Rate resolution is keyed by the PAYMENT's collected_at, never `now` — latest CommissionRate for
 *     (country,currency,tier) with effective_from ≤ collected_at. An amendment is a NEW forward row,
 *     so history is frozen at the rate in force when the payment was collected.
 *   • Tier: first_12m iff elapsedMonths(activation, collected_at) < 12, else thereafter. The first
 *     twelve payments (elapsed 0..11) are first_12m; month 12 onward is thereafter.
 *   • Trial gate: no commission on collected_at < trial_ends_at; == activation accrues (inclusive).
 *   • Split: one payment's commission splits by share_bp across active attributions (Σ = 10000, else
 *     it is a config error and we THROW — never a silent under-pay). Largest-remainder, no penny lost.
 *   • Clawback: a refund writes a NEGATIVE entry, pro-rata by refunded fraction; it never mutates the
 *     original accrual. A paid accrual + a pending clawback = a debt recovered from a future payout.
 *   • Currency: rate is looked up in the payment's currency; a missing rate THROWS (honest-null) —
 *     never a GBP fallback, never a silent zero.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type Tier = 'first_12m' | 'thereafter';
export const TIER_BOUNDARY_MONTHS = 12; // elapsed < 12 → first_12m (the twelve intro payments)

export type Payment = { ref: string; collected_at: Date; amount_pennies: number; currency: string };
export type Refund = { ref: string; payment_ref: string; amount_pennies: number; refunded_at: Date };

/** Payments/refunds source. Prod: Stripe/GroupBilling. Test: synthetic in-memory rows. */
export interface PaymentLedger {
  collectedPayments(groupId: string, from: Date, to: Date): Promise<Payment[]>;
  refunds(groupId: string, from: Date, to: Date): Promise<Refund[]>;
  paymentByRef(groupId: string, ref: string): Promise<Payment | null>;
}

export type CommissionLine = {
  party_type: string; party_id: string; tier: Tier; rate_id: string;
  share_bp: number; amount_pennies: number; currency: string;
};

type Tenant = { groupId: string; activation: Date | null; country: string };

// ── pure date maths (no wall-clock) ──────────────────────────────────────────────────────────────
/** Whole calendar months from a→b, anchored on a's day (b before a's day-of-month = not yet elapsed). */
export function elapsedMonths(a: Date, b: Date): number {
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return m;
}
export function tierForTenure(activation: Date, collectedAt: Date): Tier {
  return elapsedMonths(activation, collectedAt) < TIER_BOUNDARY_MONTHS ? 'first_12m' : 'thereafter';
}
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function monthRange(period: string): [Date, Date] {
  const [y, m] = period.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
}

/** Largest-remainder split of `total` across shares (Σ bp = 10000); deterministic, no penny lost. */
export function splitAmount(total: number, shares: Array<{ id: string; bp: number }>): Map<string, number> {
  const parts = shares.map((s) => {
    const exact = (total * s.bp) / 10000;
    const base = Math.floor(exact);
    return { id: s.id, base, rem: exact - base };
  });
  let remainder = total - parts.reduce((a, p) => a + p.base, 0);
  // Distribute the leftover pennies to the largest fractional remainders (ties: input order).
  parts.map((p, i) => ({ p, i })).sort((x, y) => (y.p.rem - x.p.rem) || (x.i - y.i)).forEach(({ p }) => {
    if (remainder > 0) { p.base += 1; remainder -= 1; }
  });
  return new Map(parts.map((p) => [p.id, p.base]));
}

// ── DB reads ─────────────────────────────────────────────────────────────────────────────────────
async function loadTenant(db: Db, groupId: string): Promise<Tenant> {
  const g = await (db as any).group.findUnique({ where: { id: groupId }, select: { id: true, trial_ends_at: true, tax_country_code: true } });
  if (!g) throw new Error(`COMMISSION: tenant ${groupId} not found`);
  return { groupId: g.id, activation: g.trial_ends_at ?? null, country: g.tax_country_code };
}

/** Rate at a payment's collected_at: latest effective_from ≤ collected_at. THROWS if none (honest-null). */
async function resolveRate(db: Db, country: string, currency: string, tier: Tier, collectedAt: Date) {
  const r = await (db as any).commissionRate.findFirst({
    where: { country_code: country, currency, tier, effective_from: { lte: collectedAt } },
    orderBy: { effective_from: 'desc' },
  });
  if (!r) throw new Error(`COMMISSION: no rate for ${country}/${currency}/${tier} at ${collectedAt.toISOString()} — refusing to invent one`);
  return r as { id: string; amount_pennies: number };
}

/** Attributions active at an instant (effective_from ≤ at < ended_at). Σ share_bp must be 10000. */
async function attributionsAt(db: Db, groupId: string, at: Date) {
  const rows = await (db as any).tenantAttribution.findMany({
    where: { group_id: groupId, effective_from: { lte: at }, OR: [{ ended_at: null }, { ended_at: { gt: at } }] },
    orderBy: { created_at: 'asc' },
  });
  const sum = rows.reduce((a: number, r: any) => a + r.share_bp, 0);
  if (rows.length === 0) throw new Error(`COMMISSION: ${groupId} has no active attribution at ${at.toISOString()}`);
  if (sum !== 10000) throw new Error(`COMMISSION: active shares for ${groupId} at ${at.toISOString()} sum to ${sum}, not 10000 — config error, refusing to under/over-pay`);
  return rows as Array<{ id: string; party_type: string; party_id: string; share_bp: number }>;
}

// ── THE CORE: per-payment lines (shared by forecast AND materialise, so they cannot diverge) ──────
export async function linesForPayment(db: Db, tenant: Tenant, p: Payment): Promise<CommissionLine[]> {
  if (!tenant.activation || p.collected_at < tenant.activation) return []; // TRIAL GATE (== activation accrues)
  const tier = tierForTenure(tenant.activation, p.collected_at);
  const rate = await resolveRate(db, tenant.country, p.currency, tier, p.collected_at); // keyed by collected_at
  const attrs = await attributionsAt(db, tenant.groupId, p.collected_at);
  const split = splitAmount(rate.amount_pennies, attrs.map((a) => ({ id: a.id, bp: a.share_bp })));
  return attrs.map((a) => ({
    party_type: a.party_type, party_id: a.party_id, tier, rate_id: rate.id,
    share_bp: a.share_bp, amount_pennies: split.get(a.id)!, currency: p.currency,
  }));
}

// ── FORECAST (read-only): the Engine Room open-month projection AND the rep dashboard read this. ──────────
export type PartyKey = string; // `${party_type}:${party_id}`
const keyOf = (l: { party_type: string; party_id: string }) => `${l.party_type}:${l.party_id}`;

export async function computeCommission(
  db: Db, groupId: string, period: string, ledger: PaymentLedger,
): Promise<{ byParty: Record<PartyKey, number>; currency: string | null }> {
  const tenant = await loadTenant(db, groupId);
  const [from, to] = monthRange(period);
  const byParty: Record<PartyKey, number> = {};
  let currency: string | null = null;
  const add = (l: CommissionLine, sign: number) => { byParty[keyOf(l)] = (byParty[keyOf(l)] ?? 0) + sign * l.amount_pennies; currency = l.currency; };

  for (const p of await ledger.collectedPayments(groupId, from, to)) {
    for (const l of await linesForPayment(db, tenant, p)) add(l, +1);
  }
  // Clawbacks land in the REFUND's month, computed from the ORIGINAL payment's frozen lines × fraction.
  for (const r of await ledger.refunds(groupId, from, to)) {
    const orig = await ledger.paymentByRef(groupId, r.payment_ref);
    if (!orig) continue;
    const fraction = Math.min(1, r.amount_pennies / orig.amount_pennies);
    for (const l of await linesForPayment(db, tenant, orig)) add({ ...l, amount_pennies: Math.round(l.amount_pennies * fraction) }, -1);
  }
  return { byParty, currency };
}

// ── MATERIALISE (writes): the Stripe paid/refund webhook path. Idempotent via the unique index. ───
async function insertIdempotent(db: Db, data: any): Promise<'written' | 'noop'> {
  try { await (db as any).commissionEntry.create({ data }); return 'written'; }
  catch (e: any) { if (e?.code === 'P2002') return 'noop'; throw e; } // re-delivered webhook = no-op
}

/** Accrue a collected payment (Stripe invoice.paid). One entry per attributed party; idempotent on the payment ref. */
export async function accruePayment(db: Db, groupId: string, p: Payment): Promise<{ written: number; noop: number }> {
  const tenant = await loadTenant(db, groupId);
  let written = 0, noop = 0;
  for (const l of await linesForPayment(db, tenant, p)) {
    const r = await insertIdempotent(db, {
      group_id: groupId, party_type: l.party_type, party_id: l.party_id, period: periodOf(p.collected_at),
      kind: 'accrual', tier: l.tier, rate_id: l.rate_id, share_bp: l.share_bp, amount_pennies: l.amount_pennies,
      currency: l.currency, source_ref: p.ref, payment_ref: p.ref, status: 'pending',
    });
    r === 'written' ? written++ : noop++;
  }
  return { written, noop };
}

/**
 * Clawback a refund (Stripe charge.refunded). Writes NEGATIVE entries computed from the original
 * payment's frozen lines × the refunded fraction. NEVER mutates the original accrual: if that accrual
 * is already `paid` (cash left in a payout), this pending negative is a DEBT recovered from the next
 * run; if still `pending`, the two net to zero and no cash ever moves. Idempotent on the refund ref.
 */
export async function clawbackRefund(db: Db, groupId: string, r: Refund, orig: Payment): Promise<{ written: number; noop: number }> {
  const tenant = await loadTenant(db, groupId);
  const fraction = Math.min(1, r.amount_pennies / orig.amount_pennies);
  let written = 0, noop = 0;
  for (const l of await linesForPayment(db, tenant, orig)) {
    const res = await insertIdempotent(db, {
      group_id: groupId, party_type: l.party_type, party_id: l.party_id, period: periodOf(r.refunded_at),
      kind: 'clawback', tier: l.tier, rate_id: l.rate_id, share_bp: l.share_bp,
      amount_pennies: -Math.round(l.amount_pennies * fraction), currency: l.currency,
      source_ref: r.ref, payment_ref: orig.ref, status: 'pending',
    });
    res === 'written' ? written++ : noop++;
  }
  return { written, noop };
}
