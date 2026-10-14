/**
 * File: lib/quote-preview.ts
 *
 * THE CUSTOMER VIEW IS A STEP BEFORE SEND, NOT A PREVIEW BUTTON.
 *
 * `garage_notes` reached customers once and was caught only because somebody happened to look. So
 * looking is no longer optional: a quote cannot be sent until the real customer document has been
 * rendered for this exact draft, and editing anything afterwards invalidates that BY DIVERGENCE —
 * there is no "mark it stale" path to forget.
 *
 * ── WHY THE FINGERPRINT IS COMPUTED HERE AND NOWHERE ELSE ───────────────────────────────────────
 * The obvious shape was to hash the string the builder already serialises for its autosave and
 * send it up. That is two spellings of one fact: the client decides what is in the hash and the
 * server trusts it, so a field added on one side silently stops being covered on the other
 * ([[identical-by-construction]] is the memory for exactly this). Instead BOTH the recorder and
 * the send guard call this one function against the STORED draft, so they cannot disagree and a
 * client cannot claim to have looked at something it did not render.
 *
 * WHAT IS IN IT: everything the customer would see — the lines, their prices and VAT, the option
 * groups, the options, and every incentive. NOT the internal grain (unit_cost, labour_outsourced),
 * because changing a cost does not change what the customer reads and should not force a re-look.
 * The narrative joins this list the moment it is authored on the card rather than at send.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

type Db = Prisma.TransactionClient | typeof prisma;

/** What the customer would read, as a stable string. Order is explicit — a set that reorders is
 *  not a different quote, and a hash that moved on row order would demand a pointless re-look. */
export async function draftFingerprint(jobCardId: string, db: Db = prisma): Promise<string> {
  const [items, groups, options, card] = await Promise.all([
    db.jobCardItem.findMany({
      where: { job_card_id: jobCardId },
      select: { id: true, description: true, qty: true, unit_price: true, vat_rate: true, option_draft_id: true },
    }),
    db.quoteOptionGroupDraft.findMany({
      where: { job_card_id: jobCardId }, select: { id: true, shape: true, title: true, position: true },
    }),
    db.quoteOptionDraft.findMany({
      where: { job_card_id: jobCardId },
      select: {
        id: true, group_id: true, is_base: true, title: true, position: true,
        incentive_kind: true, incentive_label: true, incentive_percent_bp: true,
        incentive_ex_pennies: true, incentive_vatable: true, incentive_gross_off_pennies: true,
      },
    }),
    db.jobCard.findUnique({ where: { id: jobCardId }, select: { vat_rate: true } }),
  ]);

  const shape = {
    vatRate: String(card?.vat_rate ?? ''),
    items: items
      .map((i) => [i.id, i.description, String(i.qty), String(i.unit_price), String(i.vat_rate), i.option_draft_id ?? ''])
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    groups: groups
      .map((g) => [g.id, g.shape, g.title, g.position])
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    options: options
      .map((o) => [
        o.id, o.group_id ?? '', o.is_base, o.title, o.position,
        o.incentive_kind ?? '', o.incentive_label ?? '', o.incentive_percent_bp ?? '',
        o.incentive_ex_pennies ?? '', o.incentive_vatable ?? '', o.incentive_gross_off_pennies ?? '',
      ])
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export type PreviewState = { seen: boolean; staleReason: string | null };

/**
 * HAS THIS EXACT DRAFT BEEN LOOKED AT? Never "has anything been looked at" — a quote previewed and
 * then repriced is a quote nobody has read at the price it would go out at.
 */
export async function previewState(jobCardId: string, db: Db = prisma): Promise<PreviewState> {
  const card = await db.jobCard.findUnique({
    where: { id: jobCardId }, select: { quote_preview_hash: true },
  });
  if (!card?.quote_preview_hash) {
    return { seen: false, staleReason: 'Open the customer view first — this quote has not been read the way the customer will read it.' };
  }
  const now = await draftFingerprint(jobCardId, db);
  if (now !== card.quote_preview_hash) {
    return { seen: false, staleReason: 'The quote changed after it was previewed. Open the customer view again before sending it.' };
  }
  return { seen: true, staleReason: null };
}
