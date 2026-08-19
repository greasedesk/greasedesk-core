/**
 * File: lib/intake-escalation.ts
 * THE EMAIL THAT MAKES THE PROMPTS MEAN SOMETHING.
 *
 * lib/intake-items argues that every prompt is a question and never a lock, because a hard gate
 * gets worked around and the data ends up LOOKING captured when it isn't. That argument only holds
 * if something else supplies the pressure. This is that something.
 *
 * ── IT FIRES ON THE ADVANCE, NOT OVERNIGHT ──────────────────────────────────────────────────────
 * The value is entirely that the car is still on site. An email at 18:00 about a car that left at
 * 15:00 is a report; a manager reads it, cannot act on it, and reads the next one less carefully.
 * So the trigger is the moment a human says intake is finished — which is also the moment they have
 * decided, so it is the moment worth questioning.
 *
 * ── AND IT SAYS WHY, WHERE SOMEBODY SAID WHY ────────────────────────────────────────────────────
 * `intakeOutstanding` deliberately returns BOTH the skipped-with-a-reason and the never-touched:
 * a mechanic who pressed Skip and one who never opened the tab have left the same gap. But they
 * have not left the same MESSAGE. "Scanner faulty" tells a manager to fix a scanner; silence tells
 * them somebody walked past it. Same email, different follow-up.
 *
 * ── NOT BUILT — THE SWEEP, AND THE FILTER IT WILL NEED ──────────────────────────────────────────
 * A card whose stage is never advanced at all generates nothing here — and that is the mechanic
 * most likely to have skipped everything. It is a DIFFERENT email: this one names ITEMS and
 * intervenes, that one can only name a CARD and report a habit, because nobody was prompted for
 * anything. Folding them together would produce a mail that sometimes lists four items and
 * sometimes lists none, which reads as a bug the first time a manager sees the empty version.
 *
 * It is not built because the population to design against does not exist yet: on the only tenant
 * with history, every candidate card predates prompts being switched on, so none of them represents
 * a garage that meant to do intake and didn't.
 *
 * WHEN IT COMES, THE FILTER IS: the booking day has passed · status not `cancelled` or `no_show` ·
 * intake never advanced (neither done nor skipped) · AND at least one prompt enabled for that site.
 * Measured on 258 real cards, dropping that last clause and the booking test takes the candidate
 * set from 7 to 40 — an 82% false-positive rate on the first send of an escalation whose entire
 * design rests on being believed.
 */
import type { Prisma } from '@prisma/client';
import { sendNotification } from '@/lib/notify';
import { resolveOpsEmail, OPS_EMAIL_SELECT } from '@/lib/ops-email';
import { intakeOutstanding, type IntakeItemState, type IntakeItem } from '@/lib/intake-items';

/** The mechanic-facing name of each item, as the manager will read it. */
const ITEM_LABEL: Record<IntakeItem, string> = {
  findings: 'What the car needs',
  mileage_vin: 'Mileage and VIN',
  walkaround: 'Walkaround video',
  diag_scan: 'Diagnostic scan',
  oil_level: 'Oil level',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/**
 * One line per outstanding item. PURE, so the wording is provable without sending anything.
 *
 * A skip with a reason reads differently from one without, and both read differently from an item
 * nobody touched — three states, three sentences, because a manager's next action differs for each.
 */
export function outstandingLines(items: IntakeItemState[]): string[] {
  return items.map((i) => {
    const label = ITEM_LABEL[i.item] ?? i.item;
    if (i.skipped && i.skipReason) return `${label} — skipped: ${i.skipReason}`;
    if (i.skipped) return `${label} — skipped, no reason given`;
    return `${label} — not done`;
  });
}

export type EscalationOutcome =
  | { sent: false; reason: 'nothing_outstanding' | 'no_recipient' }
  | { sent: true; count: number; recipient: string };

/**
 * Send it, or say why not. Called AFTER the stage transaction commits, deliberately: an email is
 * not part of the card's state, and a provider wobble must never roll back a mechanic's advance.
 */
export async function escalateOutstandingIntake(
  db: Prisma.TransactionClient | typeof import('@/lib/db')['prisma'],
  args: {
    groupId: string; jobCardId: string; states: IntakeItemState[];
    registration: string | null; vehicleDesc: string | null; mechanic: string | null;
    baseUrl?: string;
  },
): Promise<EscalationOutcome> {
  const outstanding = intakeOutstanding(args.states);
  // NOTHING OUTSTANDING IS THE COMMON CASE and must be silent. An escalation that also sends on
  // success is a newsletter, and a manager unsubscribes from a newsletter.
  if (!outstanding.length) return { sent: false, reason: 'nothing_outstanding' };

  const group = await (db as { group: { findUnique: (a: unknown) => Promise<unknown> } }).group.findUnique({
    where: { id: args.groupId },
    select: OPS_EMAIL_SELECT,
  }) as Parameters<typeof resolveOpsEmail>[0];
  const { address } = resolveOpsEmail(group);
  // NO ADDRESS IS NOT A FAILURE. A garage that has given us no ops address has not asked to be
  // emailed, and inventing a recipient — the owner's login, say — is how a product starts mailing
  // people who never opted in.
  if (!address) return { sent: false, reason: 'no_recipient' };

  const lines = outstandingLines(outstanding);
  await sendNotification({
    groupId: args.groupId,
    template: 'intake_outstanding',
    channel: 'email',
    recipient: address,
    // Loose subject, per lib/notify: what the message is ABOUT, for support lookups, never an FK.
    subject: { type: 'job_card', id: args.jobCardId },
    data: {
      registration: args.registration,
      vehicleDesc: args.vehicleDesc,
      mechanic: args.mechanic,
      count: outstanding.length,
      itemsHtml: lines.map((l) => `<li>${esc(l)}</li>`).join(''),
      link: args.baseUrl ? `${args.baseUrl}/admin/jobcards/${args.jobCardId}` : null,
    },
  });
  return { sent: true, count: outstanding.length, recipient: address };
}
