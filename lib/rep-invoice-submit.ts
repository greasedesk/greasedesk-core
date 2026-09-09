/**
 * File: lib/rep-invoice-submit.ts
 * THE ONE WRITER. A rep's invoice comes into existence exactly here, or not at all.
 *
 * SPLIT FROM lib/rep-invoice ON PURPOSE. That module is pure and client-safe — the pages import its
 * rules. This one reaches the database and renders a PDF, and no client component may import it.
 *
 * ── WHAT MUST BE TRUE WHEN THIS RETURNS ok ──────────────────────────────────────────────────────
 *   • Every line named is now `billed` and points at THIS invoice, and pointed at none before.
 *   • The PDF BYTES exist in the row, with their sha256 and their true length.
 *   • All of it committed together, or none of it. The bytes and the freeze are one transaction:
 *     a row claiming lines with no document, or a document whose lines are still unbilled, are both
 *     states this record may never be in.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { COMPANY, officeOneLine } from '@/lib/company-info';
import {
  buildRepInvoiceDoc, commissionLineDescription, missingProfileFields, refuseVat,
  VAT_RATE_BP, vatAppliesTo, type Refusal,
} from '@/lib/rep-invoice';
import { isArrears } from '@/lib/rep-pay-run';
import type { RepInvoiceDoc } from '@/lib/rep-invoice';

/**
 * ── THE RENDERER IS INJECTED, AND THE REASON IS THE HARNESS, STATED ────────────────────────────
 * lib/rep-invoice-pdf is .tsx, and node --experimental-strip-types REMOVES TYPE ANNOTATIONS BUT
 * DOES NOT TRANSFORM JSX. So a gate importing this module through the loader dies on the renderer's
 * extension before reaching a single rule. That is a harness limit, not a reason to test something
 * else — the previous two times a gate could not reach a module, it asked a SERVED PAGE instead and
 * proved the wrong thing twice, months apart.
 *
 * The split, and what each half is worth:
 *   • The DEFAULT is a lazy dynamic import of the real renderer, so nothing in the app changes and
 *     the .tsx is never in this module's static graph.
 *   • rep-invoice-gate injects a stub for the transaction clauses — the claim, the count, the race,
 *     the number rule. None of those are about PDF bytes and all of them are about money.
 *   • What the stub CANNOT prove is that the real renderer produces a real document. That is proved
 *     separately, over HTTP, where Next compiles the .tsx exactly as production does.
 * Both clauses exist; neither pretends to be the other.
 */
export type PdfRenderer = (doc: RepInvoiceDoc) => Promise<Buffer>;

const defaultRenderer: PdfRenderer = async (doc) => {
  const { renderRepInvoicePdf } = await import('@/lib/rep-invoice-pdf');
  return renderRepInvoicePdf(doc);
};

export type SubmitResult =
  | { ok: true; invoiceId: string; number: string }
  | { ok: false; code: string; message: string };

const fail = (r: Refusal): SubmitResult => ({ ok: false, code: r.code, message: r.message });

/**
 * ── THE INVOICE DATE IS FLOORED AT THE RUN'S CLOSE ──────────────────────────────────────────────
 * Defaults to now. A rep cannot date an invoice before the money it bills for was signed off —
 * not because they would be trying anything, but because an invoice predating its own subject is
 * a document their accountant will query and we would have produced.
 */
export function invoiceDateFor(closedAt: Date, now: Date = new Date()): Date {
  return now.getTime() < closedAt.getTime() ? closedAt : now;
}

export async function submitRepInvoice(args: {
  repId: string;
  payRunId: string;
  number: string;
  now?: Date;
  db?: PrismaClient;
  /** Gate-only. Production callers pass nothing and get the real renderer — asserted in the gate. */
  render?: PdfRenderer;
}): Promise<SubmitResult> {
  const db = args.db ?? prisma;
  const now = args.now ?? new Date();
  const number = args.number.trim();
  if (!number) return fail({ code: 'no_number', message: 'Enter the invoice number from your own series.' });

  const rep = await db.rep.findUnique({ where: { id: args.repId } });
  if (!rep || rep.status !== 'active') return fail({ code: 'not_active', message: 'This account is not active.' });

  // ── THE PROFILE GATES THE FIRST INVOICE, AND THE UTR NEVER DOES ──────────────────────────────
  const missing = missingProfileFields(rep);
  if (missing.length) {
    return fail({ code: 'profile_incomplete', message: `Complete your profile first — still needed: ${missing.join(', ')}.` });
  }

  const run = await db.repPayRun.findUnique({ where: { id: args.payRunId } });
  if (!run) return fail({ code: 'no_run', message: 'That pay run does not exist.' });
  // A CLOSED RUN ONLY. An open run's lines can still move, and an invoice for figures that can
  // still change is a document that will be wrong by the time it is read.
  if (run.status !== 'closed' || !run.closed_at) {
    return fail({ code: 'run_open', message: 'That run has not been closed yet — you can invoice for it once it is.' });
  }

  const invoiceDate = invoiceDateFor(run.closed_at, now);
  const vatApplied = vatAppliesTo(rep, invoiceDate);

  return db.$transaction(async (tx) => {
    // ── THE LINES, LOCKED, THEN CLAIMED ────────────────────────────────────────────────────────
    // FOR UPDATE first so two submissions for the same run serialise here rather than racing on the
    // claim below. The claim itself is still conditional on the pre-state — the lock is what makes
    // the failure a clean refusal instead of one submission silently taking half the lines.
    const locked = await tx.$queryRaw<Array<{ id: string; group_id: string; period: string; amount_pennies: number; currency: string }>>`
      SELECT "id", "group_id", "period", "amount_pennies", "currency"
        FROM "CommissionEntry"
       WHERE "pay_run_id" = ${args.payRunId}
         AND "party_id" = ${args.repId}
         AND "status" = 'released'
         AND "rep_invoice_id" IS NULL
       ORDER BY "period" ASC
         FOR UPDATE`;

    // HONEST NULL: a run with nothing released for this rep is not an empty invoice, it is no
    // invoice. Producing a £0.00 document would be a demand for nothing, with a number spent on it.
    if (locked.length === 0) {
      return fail({ code: 'no_lines', message: 'There is nothing released to you in that run.' });
    }
    const currencies = [...new Set(locked.map((l) => l.currency))];
    if (currencies.length > 1) {
      return fail({ code: 'mixed_currency', message: `That run holds ${currencies.join(' and ')} for you — it needs one invoice per currency, which is not built.` });
    }

    const groups = await tx.group.findMany({ where: { id: { in: locked.map((l) => l.group_id) } }, select: { id: true, group_name: true } });
    const nameOf = (id: string) => groups.find((g) => g.id === id)?.group_name ?? 'Unknown garage';

    const docLines = locked.map((l) => ({
      period: l.period,
      isArrears: isArrears(l.period, run.period),
      garage: nameOf(l.group_id),
      description: commissionLineDescription(l.period, nameOf(l.group_id)),
      amountPennies: l.amount_pennies,
    }));

    const doc = buildRepInvoiceDoc({ rep, number, invoiceDate, currency: currencies[0], lines: docLines });
    const pdf = await (args.render ?? defaultRenderer)(doc);
    // THE HASH IS OF WHAT WAS STORED, taken from the same buffer that is written. Hashing anything
    // re-rendered would be hashing a second document that merely resembles the first.
    // Uint8Array, not the Buffer: the two disagree under this TS lib and the hash must be taken
    // over the exact bytes that are stored, not a type-compatible re-encoding of them.
    const bytes = Uint8Array.from(pdf);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const inv = await tx.repInvoice.create({
      data: {
        rep_id: rep.id,
        pay_run_id: run.id,
        rep_invoice_number: number,
        status: 'pending_review',
        invoice_date: invoiceDate,
        tax_point: doc.taxPoint,
        currency: doc.currency,
        subtotal_pennies: doc.subtotalPennies,
        vat_applied: vatApplied,
        vat_rate_bp: vatApplied ? VAT_RATE_BP : null,
        vat_pennies: doc.vatPennies,
        total_pennies: doc.totalPennies,
        rep_trading_name_snapshot: doc.from.tradingName,
        rep_address_snapshot: doc.from.address,
        rep_contact_snapshot: doc.from.contact,
        rep_vat_number_snapshot: doc.from.vatNumber,
        company_name_snapshot: COMPANY.legalName,
        company_address_snapshot: officeOneLine(),
        company_number_snapshot: COMPANY.companyNumber,
        // THE SAME BYTES that were hashed. Prisma's Bytes column takes a Uint8Array under this
        // client; handing it the Buffer and the hash a different view is how the two drift.
        pdf: bytes,
        pdf_sha256: sha256,
        pdf_bytes: bytes.length,
        submitted_at: now,
        lines: {
          create: docLines.map((l, i) => ({
            entry_id: locked[i].id,
            period: l.period,
            is_arrears: l.isArrears,
            group_name_snapshot: l.garage,
            description: l.description,
            amount_pennies: l.amountPennies,
            position: i,
          })),
        },
      },
      select: { id: true },
    });

    // ── THE CLAIM. CONDITIONAL ON THE PRE-STATE, AND COUNTED. ──────────────────────────────────
    // NOT a unique index with a caught P2002: lib/commission.ts:32 records that a caught constraint
    // violation still poisons its transaction, so the catch that looks like handling the race is
    // itself the failure. The named fact at the top of schema.prisma has the whole history.
    //
    // The count must equal the lines claimed. Anything less means another submission took some of
    // them between the lock and here, and the whole transaction is thrown away rather than issuing
    // an invoice for a subset nobody asked for.
    const claimed = await tx.commissionEntry.updateMany({
      where: { id: { in: locked.map((l) => l.id) }, status: 'released', rep_invoice_id: null },
      data: { status: 'billed', rep_invoice_id: inv.id },
    });
    if (claimed.count !== locked.length) {
      throw new Error(`REP_INVOICE_RACE:${claimed.count}/${locked.length}`);
    }

    return { ok: true as const, invoiceId: inv.id, number };
  }, { timeout: 30_000 }).catch((e: unknown) => {
    const msg = String((e as Error)?.message ?? e);
    if (msg.startsWith('REP_INVOICE_RACE')) {
      return fail({ code: 'lines_taken', message: 'Some of those lines were invoiced a moment ago. Reload and try again.' });
    }
    // A UNIQUE VIOLATION HERE IS THE REP'S OWN NUMBER, and it is the one refusal they can act on.
    //
    // MATCHED ON THE FIELDS, NOT THE INDEX NAME. Prisma reports P2002 as "Unique constraint failed
    // on the fields: (rep_id, rep_invoice_number)" and never mentions RepInvoice_rep_number_key,
    // which is what the first version of this looked for — so the refusal escaped as a raw P2002
    // and a rep reusing their own number would have got a 500 instead of "use the next number".
    // The structured meta.target is preferred where the client fills it in; the message is the
    // fallback. Written against the error Prisma ACTUALLY produces, checked rather than assumed.
    const target = String((e as { meta?: { target?: unknown } })?.meta?.target ?? "");
    if (/rep_invoice_number/.test(target) || /rep_invoice_number/.test(msg)) {
      return fail({ code: 'number_used', message: `You have already issued invoice ${number}. Use the next number in your series.` });
    }
    if (/one_live_per_run|pay_run_id/.test(target) || /one_live_per_run/.test(msg)) {
      return fail({ code: 'already_invoiced', message: 'You already have an invoice for that run.' });
    }
    throw e;
  });
}

/**
 * THE STORED BYTES, AND NOTHING RE-RENDERED. The only way to read a submitted invoice.
 * There is deliberately no "regenerate" here and no caller may build one: refuseIfSubmitted says
 * why, and rep-invoice-gate asserts that nothing calls the renderer for a row that exists.
 */
export async function storedRepInvoicePdf(invoiceId: string, db: PrismaClient = prisma) {
  return db.repInvoice.findUnique({
    where: { id: invoiceId },
    select: { pdf: true, pdf_sha256: true, pdf_bytes: true, rep_invoice_number: true, rep_id: true },
  });
}
