import { optionFromRow, groupFromRow, type GroupLite } from '@/lib/quote-options';
/**
 * File: lib/quote-doc.ts
 * THE resolver of a QUOTE's renderable document — the sibling of lib/invoice-doc, deliberately
 * returning the SAME line + totals shape so the customer's quote and the invoice they later receive
 * are one document rendered twice, not two documents that happen to look alike.
 *
 * WHY A SIBLING AND NOT buildInvoiceDoc: that function is bound to an Invoice row (it reads
 * InvoiceLine, invoice_number, issued_at, series, paid dates and the issue-time snapshots). A quote
 * has none of those — there is no Invoice until issue. So the shared things are what CAN drift:
 *   • the line shape (DocLine) — identical fields
 *   • the totals maths — the SAME invoiceTotals(), never a second VAT aggregation
 *   • the presentational component (components/DocumentLines) both pages render through
 * The stronger guarantee lands in slice-2b: the accepted version's frozen rows are copied into
 * InvoiceLine at issue, so the figures are identical by construction.
 *
 * Server-only. unit_cost lives on the frozen line for the invoice copy and NEVER leaves this module.
 */
import { prisma } from '@/lib/db';
import { invoiceTotals, type InvoiceTotals } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';
import type { OptionLite } from '@/lib/quote-options';
import { presignGet } from '@/lib/r2';
import { resolveContactRoutes, type ContactRoutes } from '@/lib/contact-routes';

/** Identical field-for-field to InvoiceDocLine — the shape both documents render. */
export type DocLine = {
  description: string;
  qty: number;
  unitPricePennies: number;
  vatRate: number;
  netPennies: number;
  vatPennies: number;
};

export type QuoteDoc = {
  quoteVersionId: string;
  jobCardId: string;
  version: number;
  status: 'sent' | 'accepted' | 'declined' | 'superseded';
  sentAt: Date;
  expiresAt: Date;
  vatRegistered: boolean;
  taxLabel: string;
  logoUrl: string | null;
  company: { name: string; vatNumber: string | null; address: string | null; phone: string | null; email: string | null };
  /** Phone + WhatsApp, each resolved site → group INDEPENDENTLY by the ONE resolver
   *  (lib/contact-routes). `setupGap` is true only when NEITHER route exists — the page flags that
   *  out loud rather than silently dropping the customer's escape hatch. */
  contact: ContactRoutes;
  customer: { name: string };
  vehicle: { reg: string | null; desc: string | null; mileage: number | null };
  /**
   * ── THE GARAGE'S EXPLANATION, IN ITS OWN WORDS ────────────────────────────────────────────────
   * Why this work and what they would do, above any line item. Read from QuoteVersion.narrative,
   * so it is FROZEN with the version a customer was sent.
   *
   * This used to be `JobCard.garage_notes`, which the schema documents as "internal staff notes on
   * the job" — rendered straight onto the customer's page. Nine versions on this database had one
   * and all nine were gate fixtures, so nothing real leaked, but it was a leak waiting for its
   * first real note. It is also card-level and LIVE: editing it would silently rewrite the wording
   * of a quote already sent.
   */
  narrative: string | null;
  /** The operator's explanation of THIS revision. Shown above the work description. */
  revisionNote: string | null;
  lines: DocLine[];
  /** Options on THIS version, for the selector and the printed layout (lib/quote-options). */
  options: OptionLite[];
  /** The GROUPS those options sit in. Shipped together because the shape decides what choosing
   *  means, and a document that rendered options without them would be guessing (lib/quote-options). */
  optionGroups: GroupLite[];
  totals: InvoiceTotals;
  currency: string;
  locale: string;
};

export async function buildQuoteDoc(quoteVersionId: string, expiresAt: Date): Promise<QuoteDoc | null> {
  const v = (await prisma.quoteVersion.findUnique({
    where: { id: quoteVersionId },
    select: {
      id: true, job_card_id: true, version: true, status: true, sent_at: true,
      vat_registered: true, tax_label: true, note: true, narrative: true,
      options: { orderBy: { position: 'asc' } },
      option_groups: { orderBy: { position: 'asc' } },
      /**
       * THE MAIN QUOTE ONLY. `option_id: null` is what makes a line part of the quote itself rather
       * than one of its alternatives — and without this filter the printed table and the totals
       * carried EVERY option at once. Measured: a £1,200 quote with two additions and three
       * variations rendered as £2,160, which is the main work plus every option on offer, including
       * three mutually exclusive ones. It is the same rule as GROSS_PENNIES_MEANS, applied to the
       * document instead of the column.
       */
      lines: {
        where: { option_id: null },
        orderBy: { position: 'asc' },
        select: { description: true, qty: true, unit_price: true, vat_rate: true, line_vat: true, line_total: true },
      },
      group: { select: { group_name: true, trading_name: true, vat_number: true, address: true, logo_r2_key: true, phone: true, whatsapp: true } },
      job_card: {
        select: {
          odometer_in: true,
          customer: { select: { name: true } },
          vehicle: { select: { registration: true, make: true, model: true, colour: true, mileage_at_create: true } },
          site: { select: { currency_code: true, locale: true, phone: true, whatsapp: true, site_name: true, address: true } },
        },
      },
    },
  })) as any;
  if (!v) return null;

  // SAME mapping as invoice-doc: pounds→pennies at the edge, then ONE totals aggregation.
  // ONE widened read for the three columns the generated client does not narrow here, instead of
  // three separate casts: each `as any` is a place the type-checker stops seeing a missing select.
  const vv = v as { narrative?: string | null; note?: string | null; options?: any[]; option_groups?: any[] };
  const lines: DocLine[] = v.lines.map((l: any) => ({
    description: l.description,
    qty: Number(l.qty),
    unitPricePennies: poundsToPennies(Number(l.unit_price)),
    vatRate: Number(l.vat_rate),
    netPennies: poundsToPennies(Number(l.line_total)),
    vatPennies: poundsToPennies(Number(l.line_vat)),
  }));
  const totals = invoiceTotals(
    lines.map((l) => ({ vat_rate: l.vatRate, line_total: l.netPennies / 100, line_vat: l.vatPennies / 100 })),
  );

  // ONE resolver for both routes — phone and WhatsApp cannot drift apart.
  const contact = resolveContactRoutes(v.job_card?.site, v.group);

  const veh = v.job_card?.vehicle;
  const desc = [veh?.make, veh?.model, veh?.colour].filter(Boolean).join(' ') || null;

  return {
    quoteVersionId: v.id,
    jobCardId: v.job_card_id,
    version: v.version,
    status: v.status,
    sentAt: v.sent_at,
    expiresAt,
    vatRegistered: !!v.vat_registered,
    taxLabel: v.tax_label || 'VAT',
    logoUrl: v.group?.logo_r2_key ? await presignGet(v.group.logo_r2_key) : null,
    company: {
      name: v.group?.trading_name || v.group?.group_name || 'Your garage',
      vatNumber: v.group?.vat_number ?? null,
      address: v.job_card?.site?.address ?? v.group?.address ?? null,
      phone: contact.phone,
      email: null, // form-only contact discipline — never expose a mailbox on a public page
    },
    contact,
    customer: { name: v.job_card?.customer?.name ?? '' },
    vehicle: {
      reg: veh?.registration ?? null,
      desc,
      mileage: v.job_card?.odometer_in ?? veh?.mileage_at_create ?? null,
    },
    narrative: vv.narrative || null,
    revisionNote: vv.note || null,
    lines,
    // ONE TRANSLATION, shared with the acceptance path — see lib/quote-options::optionFromRow.
    options: (vv.options ?? []).map((o: any) => optionFromRow(o)),
    optionGroups: (vv.option_groups ?? []).map((g: any) => groupFromRow(g)),
    totals,
    currency: v.job_card?.site?.currency_code ?? 'GBP',
    locale: v.job_card?.site?.locale ?? 'en-GB',
  };
}
