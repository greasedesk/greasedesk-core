/**
 * File: lib/invoice-issue.ts
 * ISSUE + FREEZE chokepoints. FREEZE-AT-ISSUE (ruling 2026-07-12, supersedes "live while
 * issued"): the lines snapshot into InvoiceLine AT MINT and the ledger reads only that copy.
 *
 *  issueInvoiceForCard          → mint a CHARGEABLE number + header snapshot + LINE FREEZE.
 *  issueWarrantyInvoiceForCard  → the comeback path: mint from the independent WARRANTY counter,
 *                                 freeze the goodwill shape (retail lines + one zeroing line,
 *                                 sum £0) and land TERMINAL at `settled` — never AR, never paid.
 *  snapshotInvoiceLines         → THE freeze: copy the card's items into InvoiceLine (with the
 *                                 frozen classification: item_type + labour_outsourced).
 *                                 Idempotent (replaces any previous snapshot) — fires at issue,
 *                                 at re-issue after an ADMIN unlock, and at re-pay.
 *
 * All run inside the caller's tx (a minted number rolls back with a failed issue). Sticky:
 * one-per-card (Invoice.job_card_id @unique) — re-entering `invoiced` never re-mints.
 * TODO(tighten): InvoiceLine.item_type is nullable only for pre-backfill legacy rows — all rows
 * were classified 2026-07-12 and every writer here sets it; tighten the column to NOT NULL in a
 * follow-up migration. A nullable classification column on the ledger is a hole waiting for a null.
 */
import { printedDueItemsBlock, openDueItemsForVehicle } from '@/lib/due-items';
import { printedTyreLines } from '@/lib/tyres';
import { Prisma } from '@prisma/client';
import { getTenantVat } from '@/lib/tenant-vat';
import { assignInvoiceNumber, assignWarrantyNumber, assignHistoricalNumber, formatInvoiceNumber } from '@/lib/invoice-number';
import { resolveCompanyIdentity } from '@/lib/invoice';
import { revokeMagicLinksForCard } from '@/lib/magic-link';
import { dueDateFor } from '@/lib/account-terms';

const CARD_SELECT = {
  site_id: true,
  odometer_in: true,
  group: { select: { group_name: true, trading_name: true, company_number: true, vat_number: true, address: true, vat_registered: true, invoice_prefix: true, invoice_pad_width: true, invoice_fy_digits: true, fy_start_month: true, invoice_warranty_prefix: true, invoice_historical_prefix: true } },
  site: { select: { company_number: true, vat_number: true, address: true } },
  customer: { select: { name: true, address: true, account_terms_days: true } },
  // mot_expiry rides along because it PRINTS on the due-items block and must freeze with it.
  vehicle: { select: { id: true, registration: true, make: true, model: true, vin: true, mileage_at_create: true, mot_expiry: true } },
} as const;

async function createInvoiceRow(
  tx: Prisma.TransactionClient,
  jobCardId: string,
  groupId: string,
  series: 'chargeable' | 'warranty' | 'historical',
): Promise<string> {
  const card = (await tx.jobCard.findUnique({ where: { id: jobCardId }, select: CARD_SELECT })) as any;
  if (!card) throw new Error('CARD_NOT_FOUND');

  const identity = resolveCompanyIdentity(card.group, card.site);
  const issuedAt = new Date();
  const seq = series === 'warranty' ? await assignWarrantyNumber(tx, groupId)
    : series === 'historical' ? await assignHistoricalNumber(tx, groupId)
    : await assignInvoiceNumber(tx, groupId);
  const number = formatInvoiceNumber(
    {
      prefix: series === 'warranty' ? card.group.invoice_warranty_prefix
        : series === 'historical' ? card.group.invoice_historical_prefix
        : card.group.invoice_prefix,
      padWidth: card.group.invoice_pad_width,
      fyDigits: card.group.invoice_fy_digits,
      fyStartMonth: card.group.fy_start_month,
      issuedAt,
    },
    seq,
  );
  const vehicleDesc = [card.vehicle?.make, card.vehicle?.model].filter(Boolean).join(' ') || null;
  // Built BEFORE the row is created, from what is true at this instant — the open findings on this
  // car plus the DVSA MOT expiry as it stands today. Same tx, so it cannot describe a different
  // moment from the rest of the document.
  // THE LATEST READING PER CORNER for this car — the tyre condition as it stood at mint, frozen
  // with everything else. A reading taken after this invoice must not change what it printed.
  const tyreRows = card.vehicle?.id
    ? await (tx as Prisma.TransactionClient).tyreReading.findMany({
        where: { group_id: groupId, vehicle_id: card.vehicle.id as string },
        orderBy: { measured_at: 'desc' },
        select: { corner: true, depth_outer_tenths: true, depth_centre_tenths: true, depth_inner_tenths: true },
      })
    : [];
  const latestTyre = new Map<string, { corner: never; depths: { outer: number; centre: number; inner: number } }>();
  for (const r of tyreRows as Array<{ corner: string; depth_outer_tenths: number; depth_centre_tenths: number; depth_inner_tenths: number }>) {
    if (!latestTyre.has(r.corner)) {
      latestTyre.set(r.corner, { corner: r.corner as never, depths: { outer: r.depth_outer_tenths, centre: r.depth_centre_tenths, inner: r.depth_inner_tenths } });
    }
  }
  const dueItemsBlock = printedDueItemsBlock({
    motExpiry: (card.vehicle?.mot_expiry as Date | null) ?? null,
    items: await openDueItemsForVehicle(tx, groupId, card.vehicle?.id as string | undefined),
    tyreLines: printedTyreLines([...latestTyre.values()]),
  });

  const invoice = await tx.invoice.create({
    data: {
      group_id: groupId,
      job_card_id: jobCardId,
      site_id: card.site_id,
      status: 'issued',
      series,
      sequence_value: seq,
      invoice_number: number,
      issued_at: issuedAt,
      date_issued: issuedAt, // the DOCUMENT date starts as the mint date; manager-editable thereafter
      // FROZEN HERE, once, from the terms as they stand at this moment (lib/account-terms).
      // CHARGEABLE ONLY: a warranty invoice is settled at £0 and collects nothing, and a historical
      // import records work already paid for elsewhere — neither can fall due, so neither gets a
      // date that would put it on a chase list.
      due_date: series === 'chargeable' ? dueDateFor(card.customer, issuedAt) : null,
      company_name_snapshot: identity.name,
      // FROZEN AT ISSUE, like every other snapshot on this row. A rebrand must not rewrite the name
      // on documents already in customers' hands.
      company_trading_name_snapshot: identity.tradingName ?? null,
      // WHAT THE CAR ALSO NEEDED, as printed. Frozen here with every other particular: the findings
      // list changes as items are closed, and the MOT expiry moves when the car is retested, so a
      // live read would make a reprint disagree with the page the customer was handed.
      due_items_snapshot: dueItemsBlock,
      company_vat_number_snapshot: identity.vatNumber,
      company_address_snapshot: identity.address,
      customer_name_snapshot: card.customer?.name ?? '',
      customer_address_snapshot: card.customer?.address ?? null,
      vehicle_reg_snapshot: card.vehicle?.registration ?? null,
      vehicle_desc_snapshot: vehicleDesc,
      vehicle_vin_snapshot: card.vehicle?.vin ?? null,
      vehicle_mileage_snapshot: card.odometer_in ?? card.vehicle?.mileage_at_create ?? null, // same resolution as the card's "Mileage in"
      vat_registered_at_issue: !!card.group.vat_registered,
    },
    select: { id: true },
  });

  // A LIVE CUSTOMER LINK MUST NOT OUTLIVE THE STATE IT WAS MINTED FOR.
  // Once the work is invoiced the quote is no longer answerable, so a link still sitting in the
  // customer's inbox can only lead somewhere useless. quote-respond refuses the answer, but a
  // refusal is the wrong place to learn this — the link should already be dead. Here rather than in
  // the four callers because THIS is the point every mint passes through (chargeable, warranty,
  // historical, import); a fifth caller added later gets the revoke without knowing it exists.
  // Same tx as the mint: a revoke that outlived a rolled-back invoice would kill a link to work
  // that is still genuinely quotable.
  await revokeMagicLinksForCard(jobCardId, 'invoiced', tx);

  return invoice.id;
}

/** Mint a chargeable invoice AND freeze its lines in the same tx (freeze-at-issue). */
/**
 * ── WILL THIS CARD BILL WHAT IT SAYS IT WILL? ───────────────────────────────────────────────────
 * ONE predicate, three callers: the mint, the re-issue, and the on-card banner. A garage finds
 * extra work, agrees it on the phone, adds it to the estimate — and every one of those three
 * surfaces has to answer the same question with the same number, or the mechanic gets a different
 * story depending on which button he presses.
 *
 * snapshotInvoiceLines resolves to the ACCEPTED quote version whenever one exists, so anything
 * added to the estimate afterwards is not billed. That is correct — a customer is billed what they
 * agreed to — and it is silent, which is not. This is the detector; the callers decide what to say.
 *
 * ── LINES FIRST, MONEY SECOND. BOTH MUST DIFFER. ────────────────────────────────────────────────
 * Naively recomputing the live total and comparing it to the frozen gross produces false refusals,
 * and it nearly shipped one: KR60LCX has SEVEN lines identical to its accepted version and came out
 * a PENNY apart, because freezeQuoteVersion sums each line's STORED vat_amount while a recompute
 * re-derives VAT from the rate. A card with nothing wrong with it would have been blocked on Monday
 * morning over 1p.
 *
 * So: if the lines are materially identical, there is nothing to say — return before any arithmetic
 * happens. Only when the lines actually differ is the money compared, and the money is summed the
 * same way the freeze sums it (qty × unit_price, plus the stored per-line VAT) so identical inputs
 * cannot produce different outputs. A reshape that keeps the total — 1 × £112.50 becoming
 * 1.5 × £75.00, which invoice 100003195 really carries — changes the lines but not the bill, and is
 * allowed through: what harms a garage is being paid a different amount from the one on the card.
 */
export type BillingDivergence = { agreedPennies: number; livePennies: number; version: number };

const lineKey = (l: { description: unknown; qty: unknown; unit_price: unknown; vat_rate: unknown }) =>
  `${String(l.description).trim()}|${Number(l.qty)}|${Math.round(Number(l.unit_price) * 100)}|${Math.round(Number(l.vat_rate ?? 0) * 100)}`;

export async function billingDivergence(
  db: any,
  jobCardId: string,
  opts: { series?: string | null } = {},
): Promise<BillingDivergence | null> {
  // Warranty settles at £0 by construction and a historical import records a document raised
  // elsewhere; neither is expected to track the live card.
  if (opts.series && opts.series !== 'chargeable') return null;

  const accepted = (await db.quoteVersion.findFirst({
    where: { job_card_id: jobCardId, status: 'accepted' },
    orderBy: { version: 'desc' },
    select: {
      version: true, gross_pennies: true,
      lines: { select: { description: true, qty: true, unit_price: true, vat_rate: true } },
    },
  })) as any;
  if (!accepted) return null; // no accepted version → the snapshot already reads the live card

  const card = (await db.jobCard.findUnique({
    where: { id: jobCardId },
    select: { group_id: true, items: { select: { description: true, qty: true, unit_price: true, vat_rate: true, vat_amount: true } } },
  })) as any;
  if (!card) return null;

  const live = [...card.items].map(lineKey).sort();
  const frozen = [...accepted.lines].map(lineKey).sort();
  if (live.length === frozen.length && live.every((k: string, i: number) => k === frozen[i])) return null;

  const vat = await getTenantVat(card.group_id);
  const livePennies = card.items.reduce((sum: number, i: any) => {
    const net = Math.round(Number(i.qty) * Number(i.unit_price) * 100);
    return sum + net + (vat.registered ? Math.round(Number(i.vat_amount ?? 0) * 100) : 0);
  }, 0);
  if (livePennies === accepted.gross_pennies) return null; // reshaped, same bill

  return { agreedPennies: accepted.gross_pennies, livePennies, version: accepted.version };
}

/** The re-issue caller. Kept as its own name because the endpoint reads better for it. */
export async function reissueDivergence(
  db: any,
  invoice: { job_card_id: string; series: string },
): Promise<BillingDivergence | null> {
  return billingDivergence(db, invoice.job_card_id, { series: invoice.series });
}

export async function issueInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string): Promise<string> {
  // ── THE CARD MUST BILL WHAT IT SAYS IT BILLS ─────────────────────────────────────────────────
  // The commonest job in a garage is finding extra work mid-repair, agreeing it on the phone and
  // billing it. Before this, that ended in a silently short invoice: the extra line sat on the card
  // and the mint took the accepted version. Proved on a throwaway card — quote agreed at £120, an
  // hour added, invoice minted at £120, no warning of any kind.
  //
  // Refusing here also covers the case where somebody DID re-quote properly and the customer never
  // answered: invoice 100003195 went out at £551.26 while an unanswered £581.26 quote sat on the
  // card, and nothing said so. Both are the same question — does the card agree with what will be
  // billed — so both get the same answer from the same predicate.
  const diverged = await billingDivergence(tx, jobCardId, { series: 'chargeable' });
  if (diverged) {
    const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
    throw new Error(
      `IMPORT_ASSERT:This job now comes to ${gbp(diverged.livePennies)}, but the price the customer agreed is `
      + `${gbp(diverged.agreedPennies)}. An invoice can only bill what has been agreed. `
      + `Confirm the new price on the job card first — the panel at the top will do it in one click.`,
    );
  }

  const id = await createInvoiceRow(tx, jobCardId, groupId, 'chargeable');
  const inv = (await tx.invoice.findUnique({ where: { id }, select: { id: true, job_card_id: true, series: true, vat_registered_at_issue: true } })) as any;
  await snapshotInvoiceLines(tx, inv, { goodwill: '', noCharge: '' }); // texts unused on the chargeable branch
  return id;
}

/**
 * Record an invoice issued under a PREVIOUS system. Draws from the historical counter — the
 * chargeable series is never touched — and freezes the lines exactly like any other issue, because
 * the frozen snapshot IS the ledger everywhere downstream.
 */
export async function issueHistoricalInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string): Promise<string> {
  const id = await createInvoiceRow(tx, jobCardId, groupId, 'historical');
  const inv = (await tx.invoice.findUnique({ where: { id }, select: { id: true, job_card_id: true, series: true, vat_registered_at_issue: true } })) as any;
  await snapshotInvoiceLines(tx, inv, { goodwill: '', noCharge: '' });
  return id;
}

/** Mint a warranty invoice, freeze the goodwill shape, and land TERMINAL at `settled` — all one tx. */
export async function issueWarrantyInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string, warrantyTexts: { goodwill: string; noCharge: string }): Promise<string> {
  const id = await createInvoiceRow(tx, jobCardId, groupId, 'warranty');
  const inv = (await tx.invoice.findUnique({ where: { id }, select: { id: true, job_card_id: true, series: true, vat_registered_at_issue: true } })) as any;
  await snapshotInvoiceLines(tx, inv, warrantyTexts);
  await tx.invoice.update({ where: { id }, data: { status: 'settled' as any } }); // £0, closed — never AR, never paid
  return id;
}

/**
 * THE freeze — copy the card's items into InvoiceLine with the frozen classification
 * (item_type + labour_outsourced). Fires at ISSUE, at RE-ISSUE after an ADMIN unlock, and
 * (idempotently) at re-pay. Chargeable → snapshot with VAT gated by registration AT ISSUE.
 * Warranty (ruling 2026-07-12, supersedes "never itemised") → the real lines at NET retail plus
 * ONE goodwill line zeroing the total (lines sum to £0 — any consumer summing warranty lines
 * still gets zero; NO VAT on any warranty line). Empty card → the legacy single £0 line.
 * `warrantyTexts` are resolved by the caller (site-locale i18n) — this chokepoint doesn't reach
 * into translation files. `freezeVehicleFacts` is TRUE only on the mark-paid path — money
 * freezes at issue, identity facts freeze at paid (the deliberate asymmetry, see invoice-doc).
 */
export async function snapshotInvoiceLines(
  tx: Prisma.TransactionClient,
  invoice: { id: string; job_card_id: string; series: 'chargeable' | 'warranty' | string; vat_registered_at_issue: boolean },
  warrantyTexts: { goodwill: string; noCharge: string },
  opts: { freezeVehicleFacts?: boolean } = {},
): Promise<void> {
  await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } }); // idempotent re-freeze

  // VEHICLE-FACT RE-SNAPSHOT — the DELIBERATE ASYMMETRY (do not "tidy" to match the line freeze):
  // money freezes at ISSUE; identity facts (reg/VIN/mileage) stay LIVE-read while issued and
  // freeze ONLY on the mark-paid path (freezeVehicleFacts: true). Company / customer identity
  // stays issue-snapshotted (different concern).
  if (opts.freezeVehicleFacts) {
    const cardNow = (await tx.jobCard.findUnique({
      where: { id: invoice.job_card_id },
      select: { odometer_in: true, vehicle: { select: { registration: true, vin: true, mileage_at_create: true } } },
    })) as any;
    if (cardNow) {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          vehicle_reg_snapshot: cardNow.vehicle?.registration ?? null,
          vehicle_vin_snapshot: cardNow.vehicle?.vin ?? null,
          vehicle_mileage_snapshot: cardNow.odometer_in ?? cardNow.vehicle?.mileage_at_create ?? null,
        },
      });
    }
  }

  if (invoice.series === 'warranty') {
    const wItems = (await tx.jobCardItem.findMany({
      where: { job_card_id: invoice.job_card_id },
      select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true, catalogue_item_id: true, labour_hours: true, labour_outsourced: true },
      orderBy: { created_at: 'asc' },
    })) as any[];
    const valuePennies = wItems.reduce((a, it) => a + Math.round(Number(it.qty) * Number(it.unit_price) * 100), 0);
    if (!wItems.length || valuePennies <= 0) {
      // Nothing valued on the card — the legacy single no-charge line (part-class: no hours, no drag).
      await tx.invoiceLine.create({
        data: {
          invoice_id: invoice.id, description: warrantyTexts.noCharge,
          qty: new Prisma.Decimal(1), unit_price: new Prisma.Decimal(0), vat_rate: new Prisma.Decimal(0),
          line_vat: new Prisma.Decimal(0), line_total: new Prisma.Decimal(0), unit_cost: new Prisma.Decimal(0),
          item_type: 'part' as any, labour_outsourced: false, position: 0,
        },
      });
      return;
    }
    // Real lines at NET retail (vat 0 on every line), then the goodwill line for −the full value:
    // the frozen lines sum to £0 by construction. The goodwill line is PART-CLASS with zero cost
    // (NEVER labour — the hours grain reads qty as hours on labour lines; classifying it labour
    // would silently add 1h of rework per warranty invoice).
    await tx.invoiceLine.createMany({
      data: [
        ...wItems.map((it, i) => ({
          invoice_id: invoice.id,
          description: it.description,
          qty: it.qty,
          unit_price: it.unit_price,
          vat_rate: new Prisma.Decimal(0),
          line_vat: new Prisma.Decimal(0),
          line_total: new Prisma.Decimal((Number(it.qty) * Number(it.unit_price)).toFixed(2)),
          unit_cost: it.unit_cost,
          catalogue_item_id: it.catalogue_item_id,
          labour_hours: it.labour_hours, // the rework-hours grain freezes with everything else
          item_type: it.item_type, labour_outsourced: !!it.labour_outsourced, // frozen classification
          position: i,
        })),
        {
          invoice_id: invoice.id,
          description: warrantyTexts.goodwill,
          qty: new Prisma.Decimal(1),
          unit_price: new Prisma.Decimal((-valuePennies / 100).toFixed(2)),
          vat_rate: new Prisma.Decimal(0),
          line_vat: new Prisma.Decimal(0),
          line_total: new Prisma.Decimal((-valuePennies / 100).toFixed(2)),
          unit_cost: new Prisma.Decimal(0),
          item_type: 'part' as any, labour_outsourced: false, // ASSERTION 1 class: no hours, no drag
          position: wItems.length,
        },
      ],
    });
    return;
  }

  const registered = !!invoice.vat_registered_at_issue;

  // ── ACCEPTED-QUOTE INHERITANCE (slice-2b) ───────────────────────────────────────────────────────
  // If the customer ACCEPTED a quote, the invoice is built from THAT frozen version — a straight
  // COLUMN COPY with no arithmetic in between, so what they were billed is byte-identical to what
  // they agreed to. Editing the estimate afterwards cannot change it: the accepted version is never
  // superseded (lib/quote-version), so this branch keeps resolving to the agreed rows.
  //
  // NO ACCEPTED VERSION → fall through to the live JobCardItem path below, UNCHANGED. Every card
  // that never used the quote flow — which is every historical card — behaves exactly as before.
  const accepted = (await tx.quoteVersion.findFirst({
    where: { job_card_id: invoice.job_card_id, status: 'accepted' },
    orderBy: { version: 'desc' },
    select: {
      id: true, version: true,
      lines: {
        orderBy: { position: 'asc' },
        select: {
          position: true, item_type: true, description: true, qty: true, unit_price: true,
          vat_rate: true, line_vat: true, line_total: true, unit_cost: true,
          labour_hours: true, labour_outsourced: true,
        },
      },
    },
  })) as any;

  if (accepted?.lines?.length) {
    await tx.invoiceLine.createMany({
      data: accepted.lines.map((l: any) => ({
        invoice_id: invoice.id,
        description: l.description,
        qty: l.qty,
        unit_price: l.unit_price,
        // The version froze VAT at SEND under the same registration gate the invoice applies at
        // issue. Re-gate here so a tenant who deregistered between send and issue cannot emit VAT.
        vat_rate: registered ? l.vat_rate : new Prisma.Decimal(0),
        line_vat: registered ? l.line_vat : new Prisma.Decimal(0),
        line_total: l.line_total, // copied, never recomputed
        unit_cost: l.unit_cost,
        catalogue_item_id: null, // the frozen line is the record; the product link is not re-resolved
        labour_hours: l.labour_hours,
        item_type: l.item_type,
        labour_outsourced: !!l.labour_outsourced,
        position: l.position,
      })),
    });
    return;
  }

  const items = (await tx.jobCardItem.findMany({
    where: { job_card_id: invoice.job_card_id },
    select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true, vat_amount: true, catalogue_item_id: true, labour_hours: true, labour_outsourced: true },
    orderBy: { created_at: 'asc' },
  })) as any[];
  if (!items.length) return;

  await tx.invoiceLine.createMany({
    data: items.map((it, i) => {
      const net = Number(it.qty) * Number(it.unit_price);
      return {
        invoice_id: invoice.id,
        description: it.description,
        qty: it.qty,
        unit_price: it.unit_price,
        vat_rate: registered ? it.vat_rate : new Prisma.Decimal(0),
        line_vat: registered ? it.vat_amount : new Prisma.Decimal(0),
        line_total: new Prisma.Decimal(net.toFixed(2)),
        unit_cost: it.unit_cost,
        catalogue_item_id: it.catalogue_item_id,
        labour_hours: it.labour_hours, // freeze the charged-hours grain with everything else
        item_type: it.item_type, labour_outsourced: !!it.labour_outsourced, // frozen classification
        position: i,
      };
    }),
  });
  /**
   * NO IMPORT ASSERTION HERE — deliberately removed 2026-07-20 (it lived here briefly).
   *
   * The assertion belongs to the MACHINE write paths (import commit and re-commit), where it catches
   * the importer freezing a bad parse — which is what it did this morning, on seven invoices. It does
   * NOT belong on the re-freeze that mark-paid performs, because by then the invoice is in the
   * ledger and an ADMIN'S EDIT IS THE SOURCE OF TRUTH, as it is in Xero. Blocking there made a
   * corrected invoice unfreezable and would have forced a second source of truth (re-baselining the
   * staged figures) to work around it.
   *
   * What still holds a correction to account is the AUDIT: unlocking a frozen invoice, re-issuing it
   * and changing a cost are each recorded with actor and before/after, so an edit to a frozen
   * invoice is never silent — it is simply not refused.
   */

}
