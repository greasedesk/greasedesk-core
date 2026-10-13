/**
 * File: lib/quote-version.ts
 * THE chokepoint for freezing a quote at send.
 *
 * WHY VERSIONS: acceptance must refer to SPECIFIC FIGURES, not a moving target. If the garage edits
 * the estimate after sending, "what the customer agreed to" must still be recoverable exactly. So a
 * send snapshots the card's lines + totals into a numbered, immutable version. Editing and
 * re-sending mints version n+1, marks n `superseded`, and REVOKES n's magic link — so an old set of
 * figures can never be accepted after it stopped being the offer.
 *
 * The frozen line columns MIRROR InvoiceLine field-for-field, so slice-2b's copy into the invoice at
 * issue is a straight column copy: no arithmetic in between, nothing that can round differently.
 * That, not two renderers agreeing, is what makes "what they accept is what they're billed" true.
 */
import { resolvePercentOff } from '@/lib/quote-options';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { revokeMagicLinksForCard } from '@/lib/magic-link';

export type FrozenQuote = {
  id: string;
  version: number;
  netPennies: number;
  vatPennies: number;
  grossPennies: number;
  lineCount: number;
};

const toPennies = (d: Prisma.Decimal | number | string | null | undefined): number =>
  Math.round(Number(d ?? 0) * 100);

/**
 * Snapshot the card's CURRENT estimate as a new version, superseding + revoking anything open.
 * Runs in ONE transaction: a half-frozen version with a live link would be exactly the ambiguity
 * versions exist to prevent.
 */
export async function freezeQuoteVersion(args: {
  groupId: string;
  jobCardId: string;
  createdByUserId?: string | null;
  vatRegistered: boolean;
  taxLabel: string;
}): Promise<FrozenQuote> {
  const items = await prisma.jobCardItem.findMany({
    where: { job_card_id: args.jobCardId },
    orderBy: { created_at: 'asc' },
    select: {
      item_type: true, description: true, qty: true, unit_price: true, vat_rate: true,
      vat_amount: true, unit_cost: true, labour_hours: true, labour_outsourced: true,
      option_draft_id: true,
    },
  });
  if (!items.length) throw new Error('NO_LINES');

  // Line money, computed ONCE here and stored. VAT is gated by the tenant's registration AT SEND —
  // the same gating the invoice applies at issue (vat_registered_at_issue).
  const rows = items.map((it: any, i: number) => {
    const net = Number(it.qty) * Number(it.unit_price);
    const vat = args.vatRegistered ? Number(it.vat_amount) : 0;
    return {
      position: i,
      item_type: it.item_type,
      description: it.description,
      qty: new Prisma.Decimal(Number(it.qty).toFixed(2)),
      unit_price: new Prisma.Decimal(Number(it.unit_price).toFixed(2)),
      vat_rate: new Prisma.Decimal(args.vatRegistered ? Number(it.vat_rate).toFixed(2) : '0.00'),
      line_vat: new Prisma.Decimal(vat.toFixed(2)),
      line_total: new Prisma.Decimal(net.toFixed(2)),
      unit_cost: it.unit_cost == null ? null : new Prisma.Decimal(Number(it.unit_cost).toFixed(2)),
      labour_hours: it.labour_hours == null ? null : new Prisma.Decimal(Number(it.labour_hours).toFixed(2)),
      labour_outsourced: it.labour_outsourced,
      /** Carried so the freeze can split main from option. Stripped before any create. */
      __draft: it.option_draft_id ?? null,
    };
  });

  /**
   * ── THE VERSION'S TOTALS ARE THE MAIN QUOTE, EXCLUDING OPTIONS ────────────────────────────────
   * lib/quote-options::GROSS_PENNIES_MEANS states it and eight readers in quotes-list and
   * quotes-metrics depend on it. Summing every row here would make a quote with three variations
   * report the price of taking all three at once — a number nobody was ever offered.
   */
  const mainRows = rows.filter((r: any) => r.__draft === null);
  const netPennies = mainRows.reduce((s: number, r: any) => s + toPennies(r.line_total), 0);
  const vatPennies = mainRows.reduce((s: number, r: any) => s + toPennies(r.line_vat), 0);

  return prisma.$transaction(async (tx: any) => {
    // Supersede anything still open. An ACCEPTED version is never superseded — it is the record of
    // what was agreed and must survive (slice-2b relies on that).
    await tx.quoteVersion.updateMany({
      where: { job_card_id: args.jobCardId, status: 'sent' },
      data: { status: 'superseded' },
    });

    const last = await tx.quoteVersion.findFirst({
      where: { job_card_id: args.jobCardId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const created = await tx.quoteVersion.create({
      data: {
        group_id: args.groupId,
        job_card_id: args.jobCardId,
        version: (last?.version ?? 0) + 1,
        status: 'sent',
        net_pennies: netPennies,
        vat_pennies: vatPennies,
        gross_pennies: netPennies + vatPennies,
        vat_registered: args.vatRegistered,
        tax_label: args.taxLabel,
        created_by_user: args.createdByUserId ?? null,
        // Main lines only; the option lines are created below, once their options have ids.
        lines: { create: mainRows.map(({ __draft, ...r }: any) => ({ ...r, option_id: null })) },
      },
      select: { id: true, version: true },
    });

    /**
     * ── THE OPTIONS, COPIED DRAFT → FROZEN ────────────────────────────────────────────────────
     * The same move JobCardItem → QuoteVersionLine makes, for the same reason: what the customer
     * was offered must stop moving the moment it is sent. Each option's totals are summed HERE,
     * once, from its own frozen lines — a draft option deliberately stores none, because a price
     * held in two places is a price that drifts.
     */
    // THE GROUPS COME FIRST, and the frozen options point at the frozen copies — never at the
    // draft ids, which belong to a card that keeps being edited after this version is sent.
    const draftGroups = await tx.quoteOptionGroupDraft.findMany({
      where: { job_card_id: args.jobCardId }, orderBy: { position: 'asc' },
    });
    const groupIdFor = new Map<string, string>();
    for (const g of draftGroups) {
      const made = await tx.quoteOptionGroup.create({
        data: { quote_version_id: created.id, shape: g.shape, position: g.position, title: g.title },
        select: { id: true },
      });
      groupIdFor.set(g.id, made.id);
    }

    const drafts = await tx.quoteOptionDraft.findMany({
      where: { job_card_id: args.jobCardId }, orderBy: { position: 'asc' },
    });
    for (const d of drafts) {
      const mine = rows.filter((r: any) => r.__draft === d.id);
      // An option with no lines is not an offer. Skipped rather than frozen as a £0 choice.
      if (!mine.length) continue;
      const oNet = mine.reduce((t: number, r: any) => t + toPennies(r.line_total), 0);
      const oVat = mine.reduce((t: number, r: any) => t + toPennies(r.line_vat), 0);
      /**
       * ── A PERCENTAGE IS RESOLVED HERE, ONCE, AND NEVER AGAIN ───────────────────────────────
       * The draft carries the RATE; the frozen option carries the PENNIES. This is the only place
       * the two meet, because a document that re-derives its own discount later can print one
       * number and bill another the moment a line, a rate or a rounding rule moves.
       *
       * Per LINE and rounded per line, then summed — the lines are what the customer reads, and
       * rounding the option total instead can differ by a penny or two from the lines explaining
       * it. The ex figure comes off the net lines and the gross figure off the gross lines, so a
       * vatable discount takes its share of the VAT with it and the two cannot disagree.
       */
      let incEx = d.incentive_ex_pennies;
      let incVatable = d.incentive_vatable;
      let incGross = d.incentive_gross_off_pennies;
      if (d.incentive_kind === 'percent_off') {
        const bp = d.incentive_percent_bp ?? 0;
        incEx = resolvePercentOff(bp, mine.map((r: any) => toPennies(r.line_total)));
        incVatable = oVat > 0;
        incGross = incVatable
          ? resolvePercentOff(bp, mine.map((r: any) => toPennies(r.line_total) + toPennies(r.line_vat)))
          : incEx;
      }
      const opt = await tx.quoteOption.create({
        data: {
          quote_version_id: created.id, kind: d.kind, position: d.position, title: d.title,
          group_key: d.group_key,
          group_id: d.group_id ? groupIdFor.get(d.group_id) ?? null : null,
          is_base: d.is_base,
          net_pennies: oNet, vat_pennies: oVat, gross_pennies: oNet + oVat,
          incentive_kind: d.incentive_kind, incentive_label: d.incentive_label,
          incentive_ex_pennies: incEx, incentive_vatable: incVatable,
          incentive_gross_off_pennies: incGross,
          incentive_percent_bp: d.incentive_percent_bp,
        },
        select: { id: true },
      });
      await tx.quoteVersionLine.createMany({
        data: mine.map(({ __draft, ...r }: any, i: number) => ({
          ...r, quote_version_id: created.id, option_id: opt.id, position: 1000 + d.position * 100 + i,
        })),
      });
    }

    return {
      id: created.id, version: created.version,
      netPennies, vatPennies, grossPennies: netPennies + vatPennies,
      lineCount: rows.length,
    };
  });
}

/** Attach the credential that was minted for this version (and who it went to). */
export async function attachMagicLink(versionId: string, magicLinkId: string, sentTo: string | null): Promise<void> {
  await prisma.quoteVersion.update({
    where: { id: versionId },
    data: { magic_link_id: magicLinkId, sent_to: sentTo },
  });
}

/**
 * MATERIAL-CHANGE COMPARISON (pure). A quote is superseded only when the estimate the customer would
 * be looking at has CHANGED in a way THEY CAN SEE. The customer document (/c/[token], lib/quote-doc +
 * components/DocumentLines) shows exactly: description, quantity, unit price, and — only when the
 * version is VAT-registered — the VAT rate. Nothing else renders (unit_cost, labour_hours,
 * labour_outsourced and item_type never reach the page). So those, and those only, are material.
 *
 * The comparison is a MULTISET (bag) with counts, so a pure reorder is immaterial (the estimate UI
 * only reorders via delete-and-re-add, which already changes content); add / remove / value changes
 * still register as a count or key difference. Values are normalised to integer hundredths so "160"
 * and "160.00" collide, and the description is trimmed then matched exactly (case is visible).
 */
export type MaterialQuoteLine = {
  description: string;
  qty: Prisma.Decimal | number | string;
  unit_price: Prisma.Decimal | number | string;
  vat_rate: Prisma.Decimal | number | string;
};

const hundredths = (d: Prisma.Decimal | number | string | null | undefined): number => Math.round(Number(d ?? 0) * 100);

/** One line's customer-visible identity, normalised. vat_rate participates ONLY when VAT-registered —
 *  an unregistered quote shows no VAT column, so a rate change there is invisible. */
function materialKey(l: MaterialQuoteLine, vatRegistered: boolean): string {
  const desc = String(l.description ?? '').trim();
  const vr = vatRegistered ? hundredths(l.vat_rate) : 0;
  return `${desc}\0${hundredths(l.qty)}\0${hundredths(l.unit_price)}\0${vr}`;
}

/** Bag of material keys → count. Order-independent by construction. */
export function materialBag(lines: MaterialQuoteLine[], vatRegistered: boolean): Map<string, number> {
  const bag = new Map<string, number>();
  for (const l of lines) {
    const k = materialKey(l, vatRegistered);
    bag.set(k, (bag.get(k) ?? 0) + 1);
  }
  return bag;
}

/** True when two bags hold the same keys with the same counts (a permutation compares equal). */
export function bagsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, n] of a) if (b.get(k) !== n) return false;
  return true;
}

/** Are the incoming estimate lines materially identical to the frozen version the customer sees? */
export function quoteMateriallyUnchanged(
  frozen: MaterialQuoteLine[],
  incoming: MaterialQuoteLine[],
  vatRegistered: boolean,
): boolean {
  return bagsEqual(materialBag(frozen, vatRegistered), materialBag(incoming, vatRegistered));
}

export type SupersedeResult = { superseded: number; immaterial: boolean; liveVersion: number | null };

/**
 * REVOKE-ON-MATERIAL-EDIT. Called on every estimate write. Supersedes any version still `sent` AND
 * kills its magic link — but ONLY when `incoming` differs from what the customer is currently looking
 * at. A save that reproduces the frozen figures (a no-op Save, a "160"→"160.00" reformat, a
 * unit-cost-only change, a pure reorder) leaves the offer live: `{ superseded: 0, immaterial: true }`.
 * An ACCEPTED version is never touched — it is the record of what was agreed. `incoming` is the
 * estimate as it is about to be persisted (already normalised at the callsite).
 */
export async function supersedeOnMaterialEdit(jobCardId: string, incoming: MaterialQuoteLine[]): Promise<SupersedeResult> {
  const live = (await prisma.quoteVersion.findFirst({
    where: { job_card_id: jobCardId, status: 'sent' },
    orderBy: { version: 'desc' },
    select: {
      version: true, vat_registered: true,
      lines: { select: { description: true, qty: true, unit_price: true, vat_rate: true } },
    },
  })) as { version: number; vat_registered: boolean; lines: MaterialQuoteLine[] } | null;
  if (!live) return { superseded: 0, immaterial: false, liveVersion: null }; // nothing out — the common case

  if (quoteMateriallyUnchanged(live.lines, incoming, live.vat_registered)) {
    return { superseded: 0, immaterial: true, liveVersion: live.version }; // customer keeps their link
  }

  const open = await prisma.quoteVersion.count({ where: { job_card_id: jobCardId, status: 'sent' } });
  await prisma.quoteVersion.updateMany({
    where: { job_card_id: jobCardId, status: 'sent' },
    data: { status: 'superseded' },
  });
  await revokeMagicLinksForCard(jobCardId, 'superseded');
  return { superseded: open, immaterial: false, liveVersion: live.version };
}

/**
 * ── THE EXTRA HOUR NEEDS SOMETHING TO BE AGREED TO ──────────────────────────────────────────────
 * A car is on the lift, the quote is agreed, the mechanic finds another hour and the customer says
 * yes on the phone. He adds a line to the estimate. Until this existed, that produced NOTHING —
 * supersedeOnMaterialEdit looks only for a version still `sent`, an accepted card has none, so no
 * version was minted, no warning could be built, and the invoice quietly billed the old figure.
 *
 * So the edit itself mints the revision. NOT a button the mechanic has to know to press: he has
 * already done the only thing his job suggests — written down the extra work — and a control he
 * must discover is a control he will not use.
 *
 * ── MINTED UNSENT, BECAUSE NOTHING WAS SENT ─────────────────────────────────────────────────────
 * `sent_to: null` is the existing shape for a quote handed over rather than emailed, and it is the
 * honest one here: the customer agreed by phone and no message went anywhere. No magic link is
 * created — there is no customer link to hand out, and minting a credential nobody asked for would
 * be a second lie. The version exists so the garage can record what was agreed, and for no other
 * purpose.
 *
 * Returns null when there is nothing to revise: no accepted version, or the estimate still matches
 * the one that was accepted.
 */
export async function reviseAcceptedQuote(args: {
  groupId: string;
  jobCardId: string;
  incoming: MaterialQuoteLine[];
  vatRegistered: boolean;
  taxLabel: string;
  createdByUserId?: string | null;
}): Promise<{ version: number; grossPennies: number } | null> {
  // Only when there is an accepted version AND nothing already open. A `sent` version is handled by
  // supersedeOnMaterialEdit above; two revision paths firing on one save would race to mint.
  const open = await prisma.quoteVersion.count({ where: { job_card_id: args.jobCardId, status: 'sent' } });
  if (open > 0) return null;

  const accepted = (await prisma.quoteVersion.findFirst({
    where: { job_card_id: args.jobCardId, status: 'accepted' },
    orderBy: { version: 'desc' },
    select: { version: true, vat_registered: true, lines: { select: { description: true, qty: true, unit_price: true, vat_rate: true } } },
  })) as { version: number; vat_registered: boolean; lines: MaterialQuoteLine[] } | null;
  if (!accepted) return null;

  // The SAME materiality test the send path uses: a reformat or a reorder is not a new quote.
  if (quoteMateriallyUnchanged(accepted.lines, args.incoming, accepted.vat_registered)) return null;

  const frozen = await freezeQuoteVersion({
    groupId: args.groupId, jobCardId: args.jobCardId,
    createdByUserId: args.createdByUserId ?? null,
    vatRegistered: args.vatRegistered, taxLabel: args.taxLabel,
  });
  return { version: frozen.version, grossPennies: frozen.grossPennies };
}

/** The version a customer link points at, if it is still the live offer. */
export async function getLiveVersionForCard(jobCardId: string) {
  return prisma.quoteVersion.findFirst({
    where: { job_card_id: jobCardId, status: { in: ['sent', 'accepted'] } },
    orderBy: { version: 'desc' },
  });
}
