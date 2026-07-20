/**
 * File: pages/api/jobcard-quote.ts
 * Save a job card's quote/estimate (staff-side). POST { jobCardId, vatRate, items[] }.
 * Replace-all + recompute: atomically replaces the card's line items and recomputes/persists the
 * card totals (auto-setting the card value) on every save. Totals are recomputed SERVER-SIDE via
 * lib/quote-totals.ts — client-sent totals are never trusted.
 *
 * Authority (chokepoints): getVisibility + canManageSite — editing a quote (pricing) requires
 * admin/owner (any site) or site-manager (their assigned site). STANDARD users are refused (403).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma, ItemType } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canEditEstimate, financeVisibility } from '@/lib/permissions';
import { writeAudit } from '@/lib/audit';
import { getTenantVat } from '@/lib/tenant-vat';
import { requireCanWrite } from '@/lib/admin-guard';
import { canEditInvoice } from '@/lib/invoice';
import { computeQuoteTotals, poundsToPennies, penniesToPounds, QuoteLineInput, clampVatRate } from '@/lib/quote-totals';

const TYPES: ItemType[] = ['labour', 'part', 'misc', 'fixed'];

type IncomingLine = {
  item_type?: string; description?: string; qty?: number | string;
  unit_price?: number | string; unit_cost?: number | string; vatable?: boolean;
  catalogue_item_id?: string | null; // origin hook (tenant-validated below)
  labour_hours?: number | string | null; // fixed lines: charged labour content (from the service)
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, vatRate, items } = (req.body || {}) as { jobCardId?: string; vatRate?: number | string; items?: IncomingLine[] };
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });
  if (!Array.isArray(items)) return res.status(400).json({ message: 'items must be an array.' });

  // Card must be in the caller's group; editing requires authority over its site.
  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, invoice: { select: { status: true, invoice_number: true, lines: { select: { id: true }, take: 1 } } } },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);
  if (!canEditEstimate(vis, card.site_id, perms)) {
    return res.status(403).json({ message: 'You do not have permission to edit this job card’s estimate.' });
  }
  // FREEZE-AT-ISSUE: once the invoice's lines are frozen (at mint), the estimate is locked — the
  // card is the working draft only until issue. The only escape hatch is the audited ADMIN unlock
  // (which deletes the frozen lines; their absence IS the unlocked state) — never a direct edit.
  if (card.invoice && !canEditInvoice({ status: card.invoice.status, hasFrozenLines: (card.invoice.lines?.length ?? 0) > 0 })) {
    return res.status(409).json({ message: 'This job is invoiced and its lines are frozen. An admin can unlock it to make corrections.' });
  }
  if (!(await requireCanWrite(user.group_id as string, res))) return; // lapsed = read-only; saving an estimate is new work

  // Master switch + company default rate (the fallback when the client omits a rate).
  const vat = await getTenantVat(user.group_id as string);
  const rate = clampVatRate(typeof vatRate === 'string' ? parseFloat(vatRate) : (vatRate ?? vat.defaultRate));

  let saved;
  try {
    // AUTHORITY IS RE-DERIVED HERE, from financeVisibility — never taken from the request. A
    // caller who cannot see margin cannot write cost, whatever they send.
    const finWrite = financeVisibility(vis, perms);
    saved = await performEstimateSave({
      groupId: user.group_id as string, jobCardId, items, vatRate: rate, vatRegistered: vat.registered,
      costWritable: finWrite.seeMargin, actorUserId: user.id as string,
    });
  } catch (e: any) {
    if (e?.message?.startsWith('VALIDATION:')) return res.status(400).json({ message: e.message.slice('VALIDATION:'.length) });
    console.error('quote save error:', e);
    return res.status(500).json({ message: 'Failed to save estimate.' });
  }

  // Cost figures are the MARGIN grain — stripped from the response unless the saver is
  // cost-visible (same rule as the shaped page props: absent, not hidden).
  const fin = financeVisibility(vis, perms);
  const totals: any = { ...saved.totals };
  if (!fin.seeMargin) { delete totals.labour_cost_pennies; delete totals.parts_cost_pennies; }
  return res.status(200).json({ message: 'Estimate saved.', totals });
}

/**
 * THE estimate save core (exported for the proof matrix — the matrix drives the REAL write path).
 *
 * COST IS ENTERABLE ON A PARTS LINE BY COST-VISIBLE USERS (ruling 2026-07-20, revising 2026-07-12
 * and its 2026-07-17 re-affirmation). READ THIS BEFORE "restoring" the old rule: the reversal is
 * deliberate and reasoned, not a regression.
 *
 *   WHY THE OLD RULE EXISTED. 2026-07-12 was a finance-LEAK fix — unit_cost was being shipped to
 *   roles with no margin permission. Server-side prop shaping was the fix; non-writability came
 *   along as its write-side mirror, and 2026-07-17 re-affirmed it on principle ("the browser is not
 *   a source of trade-cost figures") when an inline input was tried and reverted.
 *
 *   WHY IT IS WRONG FOR PARTS. A fixed-price catalogue is the wrong model for a part: prices move
 *   weekly and differ per supplier, so the catalogue is a cache of a stale figure and the "promote
 *   it to a product" prompt asks the operator to invent a permanent price for a one-off purchase.
 *   The measured consequence was worse than the risk it avoided — ad-hoc parts carried NO cost, so
 *   parts margin was overstated or the line landed in the uncosted-exposure tally forever.
 *
 *   WHAT IS PRESERVED, because these were the parts of the ruling that answered real incidents:
 *     • VISIBILITY. The input is offered only to seeMargin (ADMIN always) and the server RE-DERIVES
 *       that authority from financeVisibility — a client claim is never trusted. The 2026-07-12 leak
 *       stays closed.
 *     • CATALOGUE PRECEDENCE. A product-linked line ALWAYS inherits the catalogue's cost server-side,
 *       whoever saves and whatever they send. A stale typed figure can never override a maintained
 *       product cost.
 *     • THREE STATES. Blank is NOT zero. An untouched field stores NULL (cost UNKNOWN, surfaced by
 *       uncostedParts); an explicit 0 stores 0 (known-free, e.g. a discount). Collapsing them would
 *       silently convert "nobody has costed this" into "this was free" and the P&L would believe it.
 *     • AUDIT. Every change is recorded (quote.cost_entered, from/to/via) because this number drives
 *       margin and FREEZES INTO THE INVOICE at issue — it was the only freeze-bound figure with no
 *       trail.
 *
 * Resolution, server-side:
 *   product-linked line → the catalogue product's unit_cost (never the client's)
 *   ad-hoc discount line (negative price) → 0 (genuinely free — a KNOWN value)
 *   ad-hoc part, cost-visible saver → the TYPED value: '' → null (unknown), a number → that number
 *   ad-hoc part, non-cost-visible saver → the existing line's cost, matched by (item_type,
 *                                         description), consumed once — never invented, never wiped
 *   genuinely new ad-hoc, no cost typed → NULL (cost UNKNOWN)
 * NULL vs 0 is deliberate: the margin readers EXCLUDE null and surface it.
 */
export async function performEstimateSave(args: {
  groupId: string; jobCardId: string; items: any[]; vatRate: number; vatRegistered: boolean;
  /** seeMargin, RE-DERIVED server-side by the caller — never a client claim. */
  costWritable?: boolean;
  /** For the cost audit: who typed it. */
  actorUserId?: string | null;
}) {
  const { groupId, jobCardId, items, vatRate, vatRegistered } = args;
  const costWritable = args.costWritable === true;

  // Validate catalogue origin ids against THIS tenant's catalogue — unknown/foreign ids drop to
  // null (SetNull-safe) — and read the SERVER truths inherited per line: outsourced flag + cost.
  const sentIds = Array.from(new Set(items.map((it) => (typeof it.catalogue_item_id === 'string' ? it.catalogue_item_id : '')).filter(Boolean)));
  const validIds = new Set<string>();
  const outsourcedIds = new Set<string>();
  const costById = new Map<string, number>();
  if (sentIds.length) {
    const found = (await prisma.catalogueItem.findMany({ where: { id: { in: sentIds }, group_id: groupId }, select: { id: true, labour_outsourced: true, unit_cost: true } })) as any[];
    found.forEach((f) => { validIds.add(f.id); if (f.labour_outsourced) outsourcedIds.add(f.id); costById.set(f.id, Number(f.unit_cost ?? 0)); });
  }
  // Existing lines: the preservation pool for ad-hoc costs (exact type+description, consumed once).
  const existing = (await prisma.jobCardItem.findMany({
    where: { job_card_id: jobCardId },
    select: { item_type: true, description: true, unit_cost: true },
    orderBy: { created_at: 'asc' },
  })) as any[];
  // Preserve the existing cost EXACTLY — including a preserved null (cost still unknown). A number
  // (incl. 0) stays a number.
  const pool = existing.map((e) => ({ key: `${e.item_type}||${String(e.description ?? '').trim()}`, cost: e.unit_cost == null ? null : Number(e.unit_cost) }));
  const takeExisting = (itemType: string, description: string): number | null => {
    const k = `${itemType}||${description}`;
    const i = pool.findIndex((p) => p.key === k);
    if (i < 0) return null; // genuinely new ad-hoc → cost UNKNOWN (null), never invented as 0
    return pool.splice(i, 1)[0].cost;
  };

  // Validate + normalise lines, resolving unit_cost SERVER-SIDE (client cost ignored entirely).
  const inputs: QuoteLineInput[] = [];
  const resolved: Array<{ description: string; catalogueItemId: string | null; outsourced: boolean; labourHours: Prisma.Decimal | null }> = [];
  for (const raw of items) {
    const t = String(raw.item_type) as ItemType;
    if (!TYPES.includes(t)) throw new Error(`VALIDATION:Invalid item_type: ${raw.item_type}`);
    const num = (v: any) => (v === '' || v == null ? 0 : Number(v));
    if (![raw.qty, raw.unit_price].every((v) => v === undefined || v === '' || v == null || Number.isFinite(Number(v)))) {
      throw new Error('VALIDATION:qty / unit_price must be numbers.');
    }
    const description = String(raw.description ?? '').trim();
    const catalogueItemId = (typeof raw.catalogue_item_id === 'string' && validIds.has(raw.catalogue_item_id)) ? (raw.catalogue_item_id as string) : null;
    // Cost resolution (client cost NEVER trusted — the browser is not a source of trade-cost figures):
    //   catalogue-linked → inherit the product cost (a known number)
    //   ad-hoc discount line (negative price) → 0 (genuinely free, a KNOWN value)
    //   ad-hoc part → preserve the existing cost by type+description (number OR null); genuinely new
    //                 → NULL (cost UNKNOWN — the catalogue prompt is how it acquires a real cost).
    // BLANK IS NOT ZERO. '' / null / undefined = the field was never filled in → cost UNKNOWN.
    // A typed '0' is an ASSERTION that the part was free, and stays 0.
    const typedCost: number | null | undefined = (() => {
      if (!costWritable) return undefined;                       // not offered → fall through below
      const v = raw.unit_cost;
      if (v === undefined) return undefined;                     // key absent → no opinion
      if (v === '' || v === null) return null;                   // cleared → UNKNOWN
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error('VALIDATION:unit_cost must be a number of 0 or more.');
      return n;
    })();
    const costPounds: number | null = catalogueItemId != null
      ? (costById.get(catalogueItemId) ?? 0)                     // catalogue ALWAYS wins
      : (num(raw.unit_price) < 0 ? 0                             // discount → known-free
        : (typedCost !== undefined ? typedCost                   // the operator's figure
          : takeExisting(t, description)));                      // else preserve what was there
    inputs.push({
      item_type: t,
      qty: num(raw.qty),
      unit_price_pennies: poundsToPennies(num(raw.unit_price)),
      unit_cost_pennies: costPounds == null ? null : poundsToPennies(Math.max(0, costPounds)), // null = UNKNOWN
      vatable: !!raw.vatable,
    });
    resolved.push({
      description,
      catalogueItemId,
      outsourced: catalogueItemId != null && outsourcedIds.has(catalogueItemId),
      labourHours: (() => { const v = raw.labour_hours; if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1000 ? new Prisma.Decimal(n.toFixed(2)) : null; })(),
    });
  }

  // Master switch: a non-registered tenant gets no VAT anywhere, regardless of per-line flags.
  const totals = computeQuoteTotals(inputs, vatRate, { vatRegistered });

  // Effective per-line values to store (mirror the compute flooring).
  const rows = inputs.map((it, i) => ({
    job_card_id: jobCardId,
    item_type: it.item_type,
    description: resolved[i].description,
    qty: new Prisma.Decimal(Math.max(0, it.qty)),
    unit_price: new Prisma.Decimal(penniesToPounds(it.item_type === 'labour' ? Math.max(0, it.unit_price_pennies) : it.unit_price_pennies)),
    unit_cost: it.unit_cost_pennies == null ? null : new Prisma.Decimal(penniesToPounds(Math.max(0, it.unit_cost_pennies))), // null = cost UNKNOWN

    vat_rate: new Prisma.Decimal(it.vatable ? totals.vat_rate : 0),
    vat_amount: new Prisma.Decimal(penniesToPounds(totals.lines[i].vat_pennies)),
    catalogue_item_id: resolved[i].catalogueItemId,
    // Inherited from the product AT SAVE (server-derived, never client-sent): frozen per line, so
    // re-flagging a product later never rewrites history.
    labour_outsourced: resolved[i].outsourced,
    // Fixed lines carry the service's charged labour content (validated non-negative number or null).
    labour_hours: resolved[i].labourHours,
  }));

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    /**
     * AUDIT THE COST BEFORE IT IS REPLACED. This number drives margin and FREEZES INTO THE INVOICE
     * at issue — after that only an audited ADMIN unlock can revisit it — and until now it was the
     * one freeze-bound figure on the card with no trail at all. Diffed per line against what was
     * there, so an unchanged cost writes nothing and a real change is attributable.
     *
     * Matched by (item_type, description) because that is the only stable identity a card line has
     * across a delete-and-recreate; a renamed line reads as a new one, which is honest.
     */
    if (costWritable) {
      const prior = (await tx.jobCardItem.findMany({
        where: { job_card_id: jobCardId },
        select: { item_type: true, description: true, unit_cost: true, catalogue_item_id: true },
        orderBy: { created_at: 'asc' },
      })) as any[];
      const key = (t: string, d: string) => `${t}||${String(d ?? '').trim()}`;
      const priorCost = new Map<string, number | null>();
      for (const p0 of prior) if (!priorCost.has(key(p0.item_type, p0.description))) {
        priorCost.set(key(p0.item_type, p0.description), p0.unit_cost == null ? null : Number(p0.unit_cost));
      }
      for (let i = 0; i < rows.length; i++) {
        if (resolved[i].catalogueItemId) continue;            // catalogue-inherited, not typed
        if (inputs[i].item_type === 'labour') continue;       // labour carries no parts cost
        const k = key(String(rows[i].item_type), resolved[i].description);
        const before = priorCost.has(k) ? priorCost.get(k)! : null;
        const after = rows[i].unit_cost == null ? null : Number(rows[i].unit_cost);
        if (before === after) continue;                       // unchanged — nothing to say
        await writeAudit(tx, {
          groupId, userId: args.actorUserId ?? null, jobCardId,
          action: 'quote.cost_entered',
          diff: {
            line: resolved[i].description,
            from: before, to: after,
            via: 'quote-form',
            meaning: after === null ? 'cost UNKNOWN (field cleared)' : (after === 0 ? 'known-free (0 asserted)' : 'cost entered'),
          },
        });
      }
    }
    await tx.jobCardItem.deleteMany({ where: { job_card_id: jobCardId } });
    if (rows.length) await tx.jobCardItem.createMany({ data: rows });
    await tx.jobCard.update({
      where: { id: jobCardId },
      data: {
        vat_rate: new Prisma.Decimal(totals.vat_rate),
        labour_bill_numeric: new Prisma.Decimal(penniesToPounds(totals.labour_pennies)),
        parts_bill_numeric: new Prisma.Decimal(penniesToPounds(totals.parts_pennies)),
        labour_cost_numeric: new Prisma.Decimal(penniesToPounds(totals.labour_cost_pennies)),
        parts_cost_numeric: new Prisma.Decimal(penniesToPounds(totals.parts_cost_pennies)),
      },
    });
  });

  return { totals };
}
