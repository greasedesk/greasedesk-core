/**
 * File: pages/api/jobcard-status.ts
 * Transition a job card's lifecycle status. POST { jobCardId, to }.
 * The state machine (lib/jobcard-status.ts) is the only place transitions/authority/gates live:
 *  - invalid jump → 400
 *  - operational transition needs canAccessSite; commercial needs canManageSite → 403 otherwise
 *  - gate unmet (estimate_exists / all_stages_done) → 409 with a clear reason
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { applyCardTransition } from '@/lib/jobcard-transition';
import { canAccessSite, canManageSite, requireCanWrite, requireTenantApi } from '@/lib/admin-guard';
import { canIssueInvoice } from '@/lib/permissions';
import { acceptQuote } from '@/lib/quote-acceptance';
import { findTransition, JobStatus, isBookedCard, stagesRemaining } from '@/lib/jobcard-status';
import { issueInvoiceForCard, issueWarrantyInvoiceForCard, snapshotInvoiceLines } from '@/lib/invoice-issue';
import { revokeMagicLinksForCard } from '@/lib/magic-link';
import { validatePaymentDate, effectiveIssueDate } from '@/lib/invoice';
import { sendInvoiceEmail } from '@/lib/invoice-email-send';
import { writeAudit } from '@/lib/audit';
// recordManualPayment, NOT recordPayment: there is no sourceRef parameter, so these calls cannot
// collide and are safe inside a transaction that continues afterwards. See lib/payments.
import { recordManualPayment } from '@/lib/payments';
import { tServer } from '@/lib/server-i18n';
import { refuseIfVoid } from '@/lib/invoice-void';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  const user = { id: scope.userId, group_id: scope.groupId };

  const { jobCardId, to, paymentMethodId, datePaid } = (req.body || {}) as { jobCardId?: string; to?: JobStatus; paymentMethodId?: string; datePaid?: string };
  if (!jobCardId || !to) return res.status(400).json({ message: 'Missing jobCardId or target status.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, status: true, is_comeback: true,
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true,
      stage_intake_skipped: true, stage_injob_skipped: true, stage_complete_skipped: true,
      odometer_in: true, vehicle: { select: { vin: true, mileage_at_create: true } },
      // The booking fact, for the booking_exists gate — the same three fields isBookedCard reads.
      resource_id: true, start_at: true, end_at: true,
      _count: { select: { items: true } },
    },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  // Comebacks stay ON the linear spine (ruling 2026-07-06 — supersedes the earlier invoiced-block +
  // the comeback-only in_progress→done bypass): they reach `invoiced` like any card, but never mint
  // from the CHARGEABLE sequence (see the numbering guard below).
  const tr = findTransition(card.status as JobStatus, to);
  if (!tr) return res.status(400).json({ message: `Cannot move from ${card.status} to ${to}.` });

  const vis = await getVisibility(scope.userId);
  // Authority by transition KIND — with ONE relaxation: raising the invoice (in_progress→invoiced) is
  // also open to a per-user can_invoice grant (canIssueInvoice). Every OTHER commercial transition
  // (quote/accept/decline/cancel/paid/done/reopen) stays manager/admin. The mint itself is unchanged.
  const permitted = tr.kind === 'operational'
    ? canAccessSite(vis, card.site_id)
    : to === 'invoiced'
      ? canIssueInvoice(vis, card.site_id)
      : canManageSite(vis, card.site_id);
  if (!permitted) {
    return res.status(403).json({
      message: tr.kind === 'commercial'
        ? 'Only a manager or admin can make this change.'
        : 'You do not have access to this job card’s location.',
    });
  }

  // Gates.
  if (tr.gate === 'estimate_exists' && (card._count?.items ?? 0) === 0) {
    return res.status(409).json({ message: 'Add at least one estimate line before quoting.' });
  }
  if (tr.gate === 'booking_exists' && !isBookedCard(card)) {
    // A no-show is a fact about a SLOT that was held and wasted. A card that never held one has
    // nothing to not show up for — cancel it instead.
    return res.status(409).json({ message: 'This job has no booking, so it can’t be a no-show. Cancel it instead.' });
  }
  if (tr.gate === 'all_stages_done') {
    // THE SHARED RULE (lib/jobcard-status::stagesRemaining). This was an inline conjunction and the
    // client kept its own copy to tell the mechanic what was left; two copies of one rule that fail
    // silently when they diverge. One function now, read by both.
    const remaining = stagesRemaining(
      { details: !!card.stage_details_done, intake: !!card.stage_intake_done, injob: !!card.stage_injob_done, complete: !!card.stage_complete_done },
      { intake: !!card.stage_intake_skipped, injob: !!card.stage_injob_skipped, complete: !!card.stage_complete_skipped },
    );
    if (remaining.length) return res.status(409).json({ message: 'Complete (or skip) all four stages first.' });
  }

  // BILLING GATE: issuing an invoice mints NEW financial work → blocked for a lapsed tenant. Marking
  // PAID is deliberately NOT gated — recording that a customer paid is reality on existing work, and
  // a lapsed garage must still be able to keep its book straight.
  // ISSUING AN INVOICE IS NEVER GATED (2026-08-06). This was the sharpest edge of the old rule: a
  // garage whose payment had failed could finish the job and then not bill for it — the one action
  // that gets them the money to pay us. Billing always continues.

  // Marking PAID requires a payment method (the grain) — validated against THIS tenant's active
  // list before the tx. No silent default: misrecorded grain is worse than a second click.
  let method: { id: string; name: string; behaviour: string } | null = null;
  let paidDate: Date | null = null; // the chosen DOCUMENT payment date (Xero-style; defaults to now)
  let instantConfirmedInvoiceId: string | null = null;
  if (to === 'paid') {
    // RESURRECTION GUARD, up front. The re-freeze below only fires on `status === 'issued'`, so a
    // void is already inert there — but the CARD would still march to `paid`, claiming a payment
    // against a retired document. Refuse the whole transition instead of half-performing it.
    const voidCheck = refuseIfVoid(await prisma.invoice.findFirst({
      where: { job_card_id: jobCardId, group_id: scope.groupId }, select: { status: true },
    }));
    if (voidCheck) return res.status(409).json(voidCheck);
    const hasUnpaidInvoice = (await prisma.invoice.findFirst({
      where: { job_card_id: jobCardId, status: 'issued' },
      select: { id: true, date_issued: true, issued_at: true },
    })) as any;
    if (hasUnpaidInvoice) {
      if (!paymentMethodId) return res.status(400).json({ message: 'Choose how this invoice was paid.' });
      method = (await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, group_id: user.group_id, active: true }, select: { id: true, name: true, behaviour: true } })) as any;
      if (!method) return res.status(400).json({ message: 'Choose how this invoice was paid.' });
      // Optional chosen payment date — guarded against the invoice's EFFECTIVE issue date.
      if (datePaid != null && String(datePaid).trim() !== '') {
        const ds = String(datePaid).trim();
        const d = /^\d{4}-\d{2}-\d{2}$/.test(ds) ? new Date(`${ds}T00:00:00.000Z`) : new Date(NaN);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'The paid date must be a valid date.' });
        const bad = validatePaymentDate(d, effectiveIssueDate(hasUnpaidInvoice), new Date());
        if (bad === 'future') return res.status(400).json({ message: 'The paid date can’t be in the future.' });
        if (bad === 'beforeIssue') return res.status(400).json({ message: 'The paid date can’t be before the invoice’s issue date.' });
        paidDate = d;
      }
    }
  }

  // Apply the transition + its side effects atomically.
  //  - invoiced: mint the invoice (once — sticky via Invoice.job_card_id @unique). The mint runs in
  //    THIS tx, so if anything fails the sequence increment rolls back too (no gap, no burned number).
  //  - paid: freeze the invoice (status=paid, paid_at) → canEditInvoice flips to false.
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (to === 'accepted') {
        // ACCEPTANCE IS NOT A GENERIC TRANSITION. It answers a live quote, stamps accepted_at and
        // writes `quote.accepted` — none of which a plain status write does. Every other target
        // below is untouched. (This branch has never fired in production: `status.accepted` has 0
        // rows in every group. It is wired anyway, because a route that exists will be taken.)
        await acceptQuote(tx, {
          groupId: scope.groupId, jobCardId, via: 'counter',
          actorUserId: scope.userId, attested: null, at: new Date(),
        });
      } else {
        // THE SHARED WRITER (lib/jobcard-transition). The table is consulted again here, which is
        // redundant for this caller — findTransition already ran above — and deliberately so: the
        // webhook path has no such preamble, and one writer that always checks is worth more than
        // two writers that each check somewhere else.
        const moved = await applyCardTransition(tx, {
          groupId: scope.groupId, jobCardId,
          from: card.status as JobStatus, to, actorUserId: scope.userId,
          // Optional free text (no-show: "didn't answer the phone"). Into the audit diff — the
          // event's own record — never a column. Ignored as undefined for every other caller.
          note: typeof req.body?.note === 'string' ? req.body.note : null,
        });
        if (!moved.ok) throw new Error(`TRANSITION:${moved.refusal.message}`);
      }
      // CANCELLING KILLS THE CUSTOMER'S LINK. It never used to — the docstring on revoked_at has
      // claimed "card cancelled" since it was written, but no caller ever passed one, which is why
      // three cancelled cards were still serving live quotes. A dead job that can still be accepted
      // is the worst of the four states: the customer says yes to work nobody is going to do.
      // In THIS tx, so a failed cancellation cannot leave the link dead behind it.
      if (to === 'cancelled') await revokeMagicLinksForCard(jobCardId, 'cancelled', tx);
      // A NO-SHOW KILLS THE LINK TOO — same defect class as cancellation: a customer who didn't
      // turn up must not still be holding a live quote link for work nobody is going to do.
      if (to === 'no_show') await revokeMagicLinksForCard(jobCardId, 'no_show', tx);
      if (to === 'invoiced') {
        // COMEBACK NUMBERING GUARD (locked): a comeback mints a £0 invoice from the SEPARATE
        // warranty series — never the chargeable customer-facing sequence. Both counters stay
        // independently gapless. Sticky either way: one invoice per card, never re-minted.
        const existing = await tx.invoice.findUnique({ where: { job_card_id: jobCardId }, select: { id: true } });
        if (!existing) {
          // PRE-MINT VIN/MILEAGE BACKSTOP (never a block — older cars legitimately lack a VIN):
          // minting without either field is a first-class audited skip, same shape as photo-stage
          // skips (actor + timestamp on the row). Written server-side IN the mint tx, so no client
          // can invoice past missing data without leaving a trail. The UI's prompt-and-skip is the
          // add-now convenience in front of this.
          const vinMissing = !(card.vehicle?.vin && String(card.vehicle.vin).trim());
          const mileageMissing = card.odometer_in == null && card.vehicle?.mileage_at_create == null;
          if (vinMissing) await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.vin_skipped' });
          if (mileageMissing) await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.mileage_skipped' });
          if (card.is_comeback) {
            // FREEZE-AT-ISSUE + SETTLED: mint from the warranty counter, freeze the goodwill
            // shape, land TERMINAL at `settled` — £0, out of AR, never paid (all inside the helper).
            const locale = (await tx.site.findUnique({ where: { id: card.site_id }, select: { locale: true } }))?.locale;
            await issueWarrantyInvoiceForCard(tx, jobCardId, scope.groupId, {
              goodwill: tServer(locale, 'invoice', 'warrantyGoodwill'),
              noCharge: tServer(locale, 'invoice', 'warrantyLine'),
            });
            await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.warranty_minted' });
          } else {
            await issueInvoiceForCard(tx, jobCardId, scope.groupId); // mints + FREEZES the lines (freeze-at-issue)
            await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.minted' });
          }
        }
      } else if (to === 'paid') {
        // FREEZE + METHOD-DRIVEN CLEARANCE (bank-style): snapshot the card's live lines (the
        // immutable income grain), record HOW it was paid, then clear per the method's behaviour:
        //   instant  → confirmed immediately (cash is in the till); receipt sends after the tx.
        //   windowed → paid_pending for the tenant's clearance window; the cron confirms.
        //   manual   → paid_pending with confirm_due_at NULL — the cron's lte-now filter never
        //              matches, so it stays pending until explicitly confirmed (warranty/EMAC).
        const inv = (await tx.invoice.findUnique({
          where: { job_card_id: jobCardId },
          // site_id IS SELECTED. Its absence here is what wrote a null onto every counter payment:
          // `siteId: inv.site_id` read an unselected field as undefined and stored null.
          select: { id: true, job_card_id: true, series: true, status: true, vat_registered_at_issue: true, site_id: true, site: { select: { locale: true } } },
        })) as any;
        if (inv && inv.series === 'warranty') throw new Error('WARRANTY_NOT_PAYABLE'); // settles at issue — nothing to pay
        if (inv && inv.status === 'issued') {
          if (!method) throw new Error('METHOD_REQUIRED'); // validated pre-tx; belt-and-braces
          // Idempotent re-freeze (covers re-pay after an ADMIN unlock) + the ONE vehicle-fact
          // freeze point (identity facts freeze at PAID — the deliberate asymmetry).
          await snapshotInvoiceLines(tx, inv, {
            goodwill: tServer(inv.site?.locale, 'invoice', 'warrantyGoodwill'),
            noCharge: tServer(inv.site?.locale, 'invoice', 'warrantyLine'),
          }, { freezeVehicleFacts: true });
          const now = new Date();
          const docDate = paidDate ?? now; // date_paid = the chosen DOCUMENT date; paid_at stays the attestation
          // ── RECORD WHAT WAS RECEIVED, not just that something was ─────────────────────────
          // Read from the lines FROZEN a few statements above, so it is the figure on the document
          // the customer is paying — not a live recomputation that could round differently.
          const frozen = await tx.invoiceLine.findMany({ where: { invoice_id: inv.id }, select: { line_total: true, line_vat: true } });
          const amountPaidPennies = frozen.reduce((a: number, l: any) => a + Math.round((Number(l.line_total) + Number(l.line_vat)) * 100), 0);
          // amount_paid_pennies is NO LONGER WRITTEN HERE. It is a cache of the Payment ledger now,
          // reconciled by lib/payments in this same transaction — two writers of one figure is how
          // a cache and its source start disagreeing.
          const methodGrain = { payment_method_id: method.id, payment_method_snapshot: method.name };
          if (method.behaviour === 'instant') {
            await tx.invoice.update({ where: { id: inv.id }, data: { status: 'paid', paid_at: now, date_paid: docDate, confirm_due_at: null, ...methodGrain } });
            // INSTANT clearance = the money is already in the drawer. Succeeded at once.
            await recordManualPayment(tx, {
              groupId: scope.groupId, invoiceId: inv.id, siteId: inv.site_id,
              amountPennies: amountPaidPennies, status: 'succeeded',
              paymentMethodId: method.id, paymentMethodSnapshot: method.name,
              collectedAt: docDate, createdBy: scope.userId,
            });
            await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.paid', diff: { date: docDate.toISOString().slice(0, 10), method: method.name, clearance: 'instant' } });
            await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.paid_confirmed', diff: { method: method.name, instant: true } });
            instantConfirmedInvoiceId = inv.id; // receipt sends post-tx through the ONE send path
          } else if (method.behaviour === 'manual') {
            await tx.invoice.update({ where: { id: inv.id }, data: { status: 'paid_pending', paid_at: now, date_paid: docDate, confirm_due_at: null, ...methodGrain } });
            // MANUAL clearance: recorded, not yet cleared. `processing` keeps it out of the cache
            // until somebody confirms the money actually arrived.
            await recordManualPayment(tx, {
              groupId: scope.groupId, invoiceId: inv.id, siteId: inv.site_id,
              amountPennies: amountPaidPennies, status: 'processing',
              paymentMethodId: method.id, paymentMethodSnapshot: method.name,
              collectedAt: docDate, createdBy: scope.userId,
            });
            await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.paid', diff: { date: docDate.toISOString().slice(0, 10), method: method.name, clearance: 'manual' } });
          } else {
            const grp = (await tx.group.findUnique({ where: { id: scope.groupId }, select: { paid_confirm_window_hours: true } })) as any;
            const windowH = Math.min(168, Math.max(1, grp?.paid_confirm_window_hours ?? 24));
            await tx.invoice.update({
              where: { id: inv.id },
              data: { status: 'paid_pending', paid_at: now, date_paid: docDate, confirm_due_at: new Date(Date.now() + windowH * 3600_000), ...methodGrain },
            });
            // WINDOWED clearance: same reasoning as manual. The window exists precisely because the
            // money might not arrive, so it cannot count until it has.
            await recordManualPayment(tx, {
              groupId: scope.groupId, invoiceId: inv.id, siteId: inv.site_id,
              amountPennies: amountPaidPennies, status: 'processing',
              paymentMethodId: method.id, paymentMethodSnapshot: method.name,
              collectedAt: docDate, createdBy: scope.userId,
            });
            await writeAudit(tx, { groupId: scope.groupId, userId: scope.userId, jobCardId, action: 'invoice.paid', diff: { date: docDate.toISOString().slice(0, 10), method: method.name, clearance: 'windowed', pendingHours: windowH } });
          }
        }
      }
    });
  } catch (e: any) {
    if (e?.message === 'WARRANTY_NOT_PAYABLE') {
      return res.status(409).json({ message: 'Warranty invoices settle at issue — there is nothing to pay.' });
    }
    // A REFUSAL, not a crash: surface the real reason. Swallowing this into a generic 500 is how
    // "Failed to update status." masked a three-figure explanation of why a freeze was refused.
    if (String((e as any)?.message ?? '').startsWith('IMPORT_ASSERT:')) {
      return res.status(409).json({ message: String((e as any).message).slice('IMPORT_ASSERT:'.length) });
    }
    console.error('Status transition error:', e);
    return res.status(500).json({ message: 'Failed to update status.' });
  }
  // Instant clearance: the receipt goes out NOW through the ONE send path (garage BCC, audited,
  // receipt_sent_at stamped). A failure leaves the visible "receipt not sent" state — resendable.
  if (instantConfirmedInvoiceId) {
    try { await sendInvoiceEmail(instantConfirmedInvoiceId, scope.groupId, scope.userId); }
    catch (e) { console.error('instant receipt send failed:', e); }
  }
  return res.status(200).json({ message: 'Status updated.', status: to });
}
