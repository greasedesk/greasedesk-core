/**
 * File: pages/api/superadmin/rates.ts
 * COMMISSION RATE ADMIN — the write surface for the CommissionRate table that lib/commission's
 * computeCommission/resolveRate already READS. Until now the table was only seeded by fixtures; this
 * is the one place an Owner amends it. OWNER-ONLY, server-enforced (any non-owner — CM/support/wrong
 * actor class — gets 404, matching operators.ts's maximal undiscoverability), every mutation audited.
 *
 * THE FREEZE DISCIPLINE (the reason this table exists):
 *   • A rate is never edited or deleted once it can affect a computation. Amending a rate = adding a
 *     NEW forward-dated row. The engine reads "latest effective_from ≤ collected_at", so a payment
 *     stays frozen at the rate in force when it was collected; a later amendment cannot move history.
 *   • POST is therefore APPEND-ONLY-FORWARD: a new row's effective_from must be strictly AFTER the
 *     latest existing boundary for its (country, currency, tier) key — you can only ever extend the
 *     timeline forward, never splice a rate into the past. (The first row for a key sets the baseline
 *     from any date.) Same-date = the overlap collision, refused; earlier date = not-forward, refused.
 *   • The ONLY mutable rows are FUTURE + UNREFERENCED: effective_from is still in the future AND no
 *     CommissionEntry was computed against it. Those can be corrected (PATCH) or removed (DELETE) —
 *     a genuine "I typoed next year's rate" fix. Anything in force, past, or referenced is immutable;
 *     the remedy there is a new forward amendment, never an edit.
 *
 * THE OVERLAP RULE, stated: for a (country, currency, tier) the effective-dated rows form a clean,
 * non-overlapping timeline — every effective_from boundary is unique (enforced here AND by a UNIQUE
 * index on the table). Two rows on the same boundary would make resolveRate's lookup ambiguous.
 *
 * WALL-CLOCK NOTE: this handler asks "has this rate taken effect yet?" — an inherently wall-clock
 * question about admin intent, so it uses new Date() for the future/in-force split. That is NOT rate
 * resolution: the engine never reads the wall clock; it resolves against the PAYMENT's collected_at.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';

const TIERS = ['first_12m', 'thereafter'] as const;
type Tier = (typeof TIERS)[number];
const COUNTRY_RE = /^[A-Z]{2}$/;   // ISO-2, e.g. GB
const CURRENCY_RE = /^[A-Z]{3}$/;  // ISO-4217, e.g. GBP

/** Audit chokepoint for rate actions. Rates target neither a tenant nor an operator, so both target
 *  ids are null (the table allows it); the (country/currency/tier) key is the snapshot. */
async function audit(actorId: string, action: string, key: string, effIso: string, detail: any) {
  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: actorId, action,
      target_group_id: null, target_operator_id: null,
      target_name_snapshot: key, target_ref_snapshot: effIso,
      detail: detail ?? Prisma.JsonNull,
    },
  });
}

const keyStr = (r: { country_code: string; currency: string; tier: string }) => `${r.country_code}/${r.currency}/${r.tier}`;
/** Parse an ISO date (YYYY-MM-DD) to UTC midnight; null if unparseable. */
function parseDate(s: unknown): Date | null {
  const str = String(s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(str + 'T00:00:00.000Z');
  return isNaN(d.getTime()) ? null : d;
}
function validAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  // Undiscoverable to non-owners: require any operator (else 404), then 404 a non-owner — never a 403
  // that would confirm "this exists, you're just not allowed". Matches the Operators surface.
  const actor = await requireOperatorApi(req, res);
  if (!actor) return;
  if (actor.role !== 'owner') { res.status(404).json({ message: 'Not found.' }); return; }

  const now = new Date(); // "in force yet?" — admin wall-clock question, NOT engine rate resolution.

  // ── LIST ───────────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const rows = await prisma.commissionRate.findMany({
      orderBy: [{ country_code: 'asc' }, { currency: 'asc' }, { tier: 'asc' }, { effective_from: 'asc' }],
    });
    // Which rate_ids have commission computed against them → immutable regardless of date.
    const referenced = new Set(
      (await prisma.commissionEntry.findMany({ select: { rate_id: true }, distinct: ['rate_id'] })).map((e: { rate_id: string }) => e.rate_id),
    );
    // Per key, the in-force row is the latest effective_from ≤ now (mirrors resolveRate at `now`).
    const inForceId = new Map<string, string>();
    for (const r of rows) {
      if (r.effective_from <= now) inForceId.set(keyStr(r), r.id); // rows are asc, so last wins
    }
    const out = rows.map((r: (typeof rows)[number]) => {
      const isRef = referenced.has(r.id);
      const status = r.effective_from > now ? 'future' : (inForceId.get(keyStr(r)) === r.id ? 'in_force' : 'superseded');
      return {
        id: r.id, country_code: r.country_code, currency: r.currency, tier: r.tier,
        effective_from: r.effective_from.toISOString().slice(0, 10),
        amount_pennies: r.amount_pennies, createdAt: r.created_at.toISOString(),
        status, referenced: isRef, editable: status === 'future' && !isRef,
      };
    });
    return res.status(200).json({ rates: out, now: now.toISOString().slice(0, 10) });
  }

  // ── ADD / FORWARD-AMEND ──────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const b = (req.body || {}) as any;
    const country_code = String(b.country_code ?? '').trim().toUpperCase();
    const currency = String(b.currency ?? '').trim().toUpperCase();
    const tier = String(b.tier ?? '').trim() as Tier;
    const amount_pennies = validAmount(b.amount_pennies);
    const effective_from = parseDate(b.effective_from);

    if (!COUNTRY_RE.test(country_code)) return res.status(400).json({ message: 'Country must be a 2-letter ISO code (e.g. GB).' });
    if (!CURRENCY_RE.test(currency)) return res.status(400).json({ message: 'Currency is required (3-letter ISO code, e.g. GBP).' });
    if (!TIERS.includes(tier)) return res.status(400).json({ message: 'Tier is required (first_12m or thereafter).' });
    if (amount_pennies === null) return res.status(400).json({ message: 'Amount must be a whole number of pennies (≥ 0).' });
    if (!effective_from) return res.status(400).json({ message: 'Effective-from must be a valid date (YYYY-MM-DD).' });

    // Append-only-forward: the new boundary must be strictly after the latest existing one for the key.
    const latest = await prisma.commissionRate.findFirst({
      where: { country_code, currency, tier }, orderBy: { effective_from: 'desc' },
    });
    if (latest) {
      if (+effective_from === +latest.effective_from) {
        return res.status(409).json({ code: 'overlap', message: `A ${keyStr({ country_code, currency, tier })} rate already starts on ${effective_from.toISOString().slice(0, 10)} — one boundary per date. Pick a later date to amend.` });
      }
      if (effective_from < latest.effective_from) {
        return res.status(409).json({ code: 'not_forward', message: `Amendments are forward-only: this key already has a rate effective ${latest.effective_from.toISOString().slice(0, 10)}. History is frozen — pick a later date.` });
      }
    }

    let created;
    try {
      created = await prisma.commissionRate.create({
        data: { country_code, currency, tier, amount_pennies, effective_from, created_by: actor.userId },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ code: 'overlap', message: 'That exact boundary already exists.' }); // DB unique backstop
      throw e;
    }
    await audit(actor.userId, 'rate.created', keyStr(created), effective_from.toISOString().slice(0, 10),
      { country_code, currency, tier, amount_pennies, effective_from: effective_from.toISOString().slice(0, 10), amended: !!latest });
    return res.status(200).json({ ok: true, id: created.id, message: latest ? 'Forward amendment added — prior rate stays frozen up to this date.' : 'Rate added.' });
  }

  // ── CORRECT a future, unreferenced row ─────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const b = (req.body || {}) as any;
    const id = String(b.id ?? '');
    if (!id) return res.status(400).json({ message: 'Missing rate id.' });
    const row = await prisma.commissionRate.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ message: 'Rate not found.' });

    const guard = await immutabilityReason(row, now);
    if (guard) return res.status(409).json({ code: 'immutable', message: guard });

    const data: { amount_pennies?: number; effective_from?: Date } = {};
    const before: any = { amount_pennies: row.amount_pennies, effective_from: row.effective_from.toISOString().slice(0, 10) };
    if (b.amount_pennies !== undefined) {
      const amt = validAmount(b.amount_pennies);
      if (amt === null) return res.status(400).json({ message: 'Amount must be a whole number of pennies (≥ 0).' });
      data.amount_pennies = amt;
    }
    if (b.effective_from !== undefined) {
      const eff = parseDate(b.effective_from);
      if (!eff) return res.status(400).json({ message: 'Effective-from must be a valid date (YYYY-MM-DD).' });
      // A correction must keep the row FUTURE (so it never splices in behind an in-force/past boundary,
      // all of which are ≤ now) and unique (the DB backstops collision with any other row).
      if (eff <= now) return res.status(409).json({ message: 'A corrected date must still be in the future — you cannot back-date a rate into effect.' });
      data.effective_from = eff;
    }
    if (data.amount_pennies === undefined && data.effective_from === undefined) return res.status(400).json({ message: 'Nothing to change.' });

    try {
      await prisma.commissionRate.update({ where: { id }, data });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ code: 'overlap', message: 'Another rate already starts on that date for this key.' });
      throw e;
    }
    const after = { ...before, ...(data.amount_pennies !== undefined ? { amount_pennies: data.amount_pennies } : {}), ...(data.effective_from ? { effective_from: data.effective_from.toISOString().slice(0, 10) } : {}) };
    await audit(actor.userId, 'rate.corrected', keyStr(row), (data.effective_from ?? row.effective_from).toISOString().slice(0, 10), { before, after });
    return res.status(200).json({ ok: true, message: 'Future rate corrected.' });
  }

  // ── REMOVE a future, unreferenced row ──────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = String((req.body?.id ?? req.query.id) ?? '');
    if (!id) return res.status(400).json({ message: 'Missing rate id.' });
    const row = await prisma.commissionRate.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ message: 'Rate not found.' });
    const guard = await immutabilityReason(row, now);
    if (guard) return res.status(409).json({ code: 'immutable', message: guard });
    await prisma.commissionRate.delete({ where: { id } });
    await audit(actor.userId, 'rate.removed', keyStr(row), row.effective_from.toISOString().slice(0, 10),
      { country_code: row.country_code, currency: row.currency, tier: row.tier, amount_pennies: row.amount_pennies, effective_from: row.effective_from.toISOString().slice(0, 10) });
    return res.status(200).json({ ok: true, message: 'Future rate removed.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}

/**
 * Why this row can't be touched — or null if it's genuinely a future, unreferenced row (the only
 * mutable state). Distinguishes the two immutability reasons for an honest message:
 *   • in force / past  → it has been (or is) the rate a payment could read; freeze discipline.
 *   • referenced       → a CommissionEntry was computed against it; history literally points here.
 */
async function immutabilityReason(row: { id: string; effective_from: Date }, now: Date): Promise<string | null> {
  if (row.effective_from <= now) return 'This rate is in force (or past) — it is frozen. To change it, add a new forward-dated amendment.';
  const refs = await prisma.commissionEntry.count({ where: { rate_id: row.id } });
  if (refs > 0) return `This rate already has ${refs} commission ${refs === 1 ? 'entry' : 'entries'} computed against it — it is frozen. Add a forward amendment instead.`;
  return null;
}
