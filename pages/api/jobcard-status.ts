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
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite, canManageSite, requireCanWrite } from '@/lib/admin-guard';
import { findTransition, JobStatus } from '@/lib/jobcard-status';
import { issueInvoiceForCard, issueWarrantyInvoiceForCard, snapshotInvoiceLines } from '@/lib/invoice-issue';
import { validatePaymentDate, effectiveIssueDate } from '@/lib/invoice';
import { sendInvoiceEmail } from '@/lib/invoice-email-send';
import { writeAudit } from '@/lib/audit';
import { tServer } from '@/lib/server-i18n';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, to, paymentMethodId, datePaid } = (req.body || {}) as { jobCardId?: string; to?: JobStatus; paymentMethodId?: string; datePaid?: string };
  if (!jobCardId || !to) return res.status(400).json({ message: 'Missing jobCardId or target status.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, status: true, is_comeback: true,
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true,
      stage_intake_skipped: true, stage_injob_skipped: true, stage_complete_skipped: true,
      odometer_in: true, vehicle: { select: { vin: true, mileage_at_create: true } },
      _count: { select: { items: true } },
    },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  // Comebacks stay ON the linear spine (ruling 2026-07-06 — supersedes the earlier invoiced-block +
  // the comeback-only in_progress→done bypass): they reach `invoiced` like any card, but never mint
  // from the CHARGEABLE sequence (see the numbering guard below).
  const tr = findTransition(card.status as JobStatus, to);
  if (!tr) return res.status(400).json({ message: `Cannot move from ${card.status} to ${to}.` });

  const vis = await getVisibility(user.id as string);
  const permitted = tr.kind === 'operational' ? canAccessSite(vis, card.site_id) : canManageSite(vis, card.site_id);
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
  if (tr.gate === 'all_stages_done') {
    // Soft gates: a photo stage counts when completed OR skipped (a skip is an audited first-class
    // event). Details is done-only — it's a data gate, never skippable.
    const allDone = card.stage_details_done
      && (card.stage_intake_done || card.stage_intake_skipped)
      && (card.stage_injob_done || card.stage_injob_skipped)
      && (card.stage_complete_done || card.stage_complete_skipped);
    if (!allDone) return res.status(409).json({ message: 'Complete (or skip) all four stages first.' });
  }

  // BILLING GATE: issuing an invoice mints NEW financial work → blocked for a lapsed tenant. Marking
  // PAID is deliberately NOT gated — recording that a customer paid is reality on existing work, and
  // a lapsed garage must still be able to keep its book straight.
  if (to === 'invoiced' && !(await requireCanWrite(user.group_id as string, res))) return;

  // Marking PAID requires a payment method (the grain) — validated against THIS tenant's active
  // list before the tx. No silent default: misrecorded grain is worse than a second click.
  let method: { id: string; name: string; behaviour: string } | null = null;
  let paidDate: Date | null = null; // the chosen DOCUMENT payment date (Xero-style; defaults to now)
  let instantConfirmedInvoiceId: string | null = null;
  if (to === 'paid') {
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
      await tx.jobCard.update({ where: { id: jobCardId }, data: { status: to } });
      await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: `status.${to}`, diff: { from: card.status, to } });
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
          if (vinMissing) await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.vin_skipped' });
          if (mileageMissing) await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.mileage_skipped' });
          if (card.is_comeback) {
            // FREEZE-AT-ISSUE + SETTLED: mint from the warranty counter, freeze the goodwill
            // shape, land TERMINAL at `settled` — £0, out of AR, never paid (all inside the helper).
            const locale = (await tx.site.findUnique({ where: { id: card.site_id }, select: { locale: true } }))?.locale;
            await issueWarrantyInvoiceForCard(tx, jobCardId, user.group_id as string, {
              goodwill: tServer(locale, 'invoice', 'warrantyGoodwill'),
              noCharge: tServer(locale, 'invoice', 'warrantyLine'),
            });
            await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.warranty_minted' });
          } else {
            await issueInvoiceForCard(tx, jobCardId, user.group_id as string); // mints + FREEZES the lines (freeze-at-issue)
            await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.minted' });
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
          select: { id: true, job_card_id: true, series: true, status: true, vat_registered_at_issue: true, site: { select: { locale: true } } },
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
          const methodGrain = { payment_method_id: method.id, payment_method_snapshot: method.name };
          if (method.behaviour === 'instant') {
            await tx.invoice.update({ where: { id: inv.id }, data: { status: 'paid', paid_at: now, date_paid: docDate, confirm_due_at: null, ...methodGrain } });
            await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.paid', diff: { date: docDate.toISOString().slice(0, 10), method: method.name, clearance: 'instant' } });
            await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.paid_confirmed', diff: { method: method.name, instant: true } });
            instantConfirmedInvoiceId = inv.id; // receipt sends post-tx through the ONE send path
          } else if (method.behaviour === 'manual') {
            await tx.invoice.update({ where: { id: inv.id }, data: { status: 'paid_pending', paid_at: now, date_paid: docDate, confirm_due_at: null, ...methodGrain } });
            await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.paid', diff: { date: docDate.toISOString().slice(0, 10), method: method.name, clearance: 'manual' } });
          } else {
            const grp = (await tx.group.findUnique({ where: { id: user.group_id as string }, select: { paid_confirm_window_hours: true } })) as any;
            const windowH = Math.min(168, Math.max(1, grp?.paid_confirm_window_hours ?? 24));
            await tx.invoice.update({
              where: { id: inv.id },
              data: { status: 'paid_pending', paid_at: now, date_paid: docDate, confirm_due_at: new Date(Date.now() + windowH * 3600_000), ...methodGrain },
            });
            await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.paid', diff: { date: docDate.toISOString().slice(0, 10), method: method.name, clearance: 'windowed', pendingHours: windowH } });
          }
        }
      }
    });
  } catch (e: any) {
    if (e?.message === 'WARRANTY_NOT_PAYABLE') {
      return res.status(409).json({ message: 'Warranty invoices settle at issue — there is nothing to pay.' });
    }
    console.error('Status transition error:', e);
    return res.status(500).json({ message: 'Failed to update status.' });
  }
  // Instant clearance: the receipt goes out NOW through the ONE send path (garage BCC, audited,
  // receipt_sent_at stamped). A failure leaves the visible "receipt not sent" state — resendable.
  if (instantConfirmedInvoiceId) {
    try { await sendInvoiceEmail(instantConfirmedInvoiceId, user.group_id as string, user.id as string); }
    catch (e) { console.error('instant receipt send failed:', e); }
  }
  return res.status(200).json({ message: 'Status updated.', status: to });
}
