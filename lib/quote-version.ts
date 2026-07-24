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
    };
  });

  const netPennies = rows.reduce((s: number, r: any) => s + toPennies(r.line_total), 0);
  const vatPennies = rows.reduce((s: number, r: any) => s + toPennies(r.line_vat), 0);

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
        lines: { create: rows },
      },
      select: { id: true, version: true },
    });

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
 * REVOKE-ON-EDIT. Called whenever the estimate changes: any version still `sent` stops being the
 * offer, and its link dies with it. Deliberately NOT touching an `accepted` version — that stays
 * frozen as the record of what was agreed.
 * Returns how many versions were closed (0 = nothing was out, the common case).
 */
export async function supersedeOnEdit(jobCardId: string): Promise<number> {
  const open = await prisma.quoteVersion.count({ where: { job_card_id: jobCardId, status: 'sent' } });
  if (!open) return 0;
  await prisma.quoteVersion.updateMany({
    where: { job_card_id: jobCardId, status: 'sent' },
    data: { status: 'superseded' },
  });
  await revokeMagicLinksForCard(jobCardId);
  return open;
}

/** The version a customer link points at, if it is still the live offer. */
export async function getLiveVersionForCard(jobCardId: string) {
  return prisma.quoteVersion.findFirst({
    where: { job_card_id: jobCardId, status: { in: ['sent', 'accepted'] } },
    orderBy: { version: 'desc' },
  });
}
