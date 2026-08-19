/**
 * File: lib/due-items.ts
 * THE due-item rules: what a valid finding is, and the one read that surfaces open ones.
 *
 * ── WHAT A DUE ITEM IS FOR ──────────────────────────────────────────────────────────────────────
 * A Platinum service on FG73KWE needed two extra items. They were visible on the car at 09:30 and
 * reached the owner at lunchtime, after the upsell window closed. A due item is that finding,
 * written down where it will be found again — this year for the upsell, next year for the reminder.
 *
 * ── THE THREE-STATE RESPONSE IS THE COMMERCIAL POINT ────────────────────────────────────────────
 * `not_raised` (nobody asked) and `declined` (asked, said no) are different facts and only the
 * second is a lead. There is NO default on the column and none here: a capture surface that
 * pre-selects one would make `declined` vanishingly rare while looking like it was recording it —
 * the failure mode is silent, which is what makes it worth a refusal rather than a default.
 *
 * ── THE CUSTOMER IS NOT PART OF THE RECORD ──────────────────────────────────────────────────────
 * Resolved at reminder time through the ownership edge. Never stored, never joined here.
 */
import type { Prisma } from '@prisma/client';

export type DueBasis = 'date' | 'mileage' | 'next_service' | 'whichever_first';
export type DueItemResponse = 'not_raised' | 'declined' | 'agreed_later' | 'wants_call';

export type DueItemRefusal = { code: string; message: string };

export type DueItemInput = {
  description: string;
  dueBasis: DueBasis | null | undefined;
  dueDate?: Date | null;
  dueMileage?: number | null;
  customerResponse: DueItemResponse | null | undefined;
};

const BASES: readonly DueBasis[] = ['date', 'mileage', 'next_service', 'whichever_first'];
const RESPONSES: readonly DueItemResponse[] = ['not_raised', 'declined', 'agreed_later', 'wants_call'];

/**
 * May this finding be recorded? PURE, so every refusal is provable without writing a row.
 *
 * The two refusals that matter are both about a MISSING DECISION, not a missing value: a basis
 * nobody chose, and a response nobody chose. Everything else is shape.
 */
export function refuseDueItem(input: DueItemInput): DueItemRefusal | null {
  if (!input.description?.trim()) {
    return { code: 'no_description', message: 'Say what the car needs.' };
  }
  if (!input.dueBasis || !BASES.includes(input.dueBasis)) {
    // NOT inferred from which value is filled. Both a date and a mileage can be present ("by March
    // or 60k, whichever comes first") and only one binds; letting the data decide is the
    // demo_expires_at defect — one column quietly answering two questions.
    return { code: 'no_basis', message: 'Choose what makes this due: a date, a mileage, or the next service.' };
  }
  if (input.dueBasis === 'date' && !(input.dueDate instanceof Date) ) {
    return { code: 'no_date', message: 'This is due by a date, so give the date.' };
  }
  if (input.dueBasis === 'mileage' && !(Number.isInteger(input.dueMileage) && (input.dueMileage as number) > 0)) {
    return { code: 'no_mileage', message: 'This is due by mileage, so give the mileage.' };
  }
  if (input.dueBasis === 'whichever_first') {
    // BOTH legs are required — that is what makes it "whichever". One leg alone is a different
    // basis and should be recorded as one, or the item silently loses the trigger that would
    // actually have fired first.
    if (!(input.dueDate instanceof Date)) {
      return { code: 'no_date', message: 'This is due by a date OR a mileage, so give the date as well.' };
    }
    if (!(Number.isInteger(input.dueMileage) && (input.dueMileage as number) > 0)) {
      return { code: 'no_mileage', message: 'This is due by a date OR a mileage, so give the mileage as well.' };
    }
  }
  if (!input.customerResponse || !RESPONSES.includes(input.customerResponse)) {
    // THE ONE THAT PROTECTS THE MARKETING LIST. No default anywhere in the stack: the person
    // recording the finding says which of the three happened, or nothing is recorded.
    return {
      code: 'no_response',
      message: 'Say whether the customer was told: not raised yet, they declined, or they want it later.',
    };
  }
  return null;
}

/**
 * `response_at` follows the response, and only an ANSWER is an event.
 * `not_raised` means nobody answered — that is an absence, not an answer at time-unknown, so the
 * column stays NULL and a reader can tell the two apart.
 */
export const responseAtFor = (r: DueItemResponse, now: Date): Date | null =>
  r === 'not_raised' ? null : now;

export type OpenDueItem = {
  id: string;
  description: string;
  dueBasis: DueBasis;
  dueDate: string | null;
  dueMileage: number | null;
  customerResponse: DueItemResponse;
  foundOnJobCardId: string | null;
  createdAt: string;
};

/**
 * OPEN items for a vehicle — THE surfacing read, shared by the job card and the booking lookup so
 * the two can never disagree about what a car still needs. Open = `closed_at IS NULL`; there is no
 * status column to drift out of step with the timestamp.
 */
export async function openDueItemsForVehicle(
  db: Prisma.TransactionClient | { vehicleDueItem: { findMany: (a: unknown) => Promise<unknown> } },
  groupId: string,
  vehicleId: string | null | undefined,
): Promise<OpenDueItem[]> {
  if (!vehicleId) return [];
  const rows = (await (db as { vehicleDueItem: { findMany: (a: unknown) => Promise<unknown> } }).vehicleDueItem.findMany({
    where: { group_id: groupId, vehicle_id: vehicleId, closed_at: null },
    orderBy: { created_at: 'desc' },
    select: {
      id: true, description: true, due_basis: true, due_date: true, due_mileage: true,
      customer_response: true, found_on_job_card_id: true, created_at: true,
    },
  })) as Array<{
    id: string; description: string; due_basis: DueBasis; due_date: Date | null; due_mileage: number | null;
    customer_response: DueItemResponse; found_on_job_card_id: string | null; created_at: Date;
  }>;
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    dueBasis: r.due_basis,
    dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
    dueMileage: r.due_mileage,
    customerResponse: r.customer_response,
    foundOnJobCardId: r.found_on_job_card_id,
    createdAt: r.created_at.toISOString().slice(0, 10),
  }));
}

/** One line of human text for a due item's timing — the same words on every surface. */
export function dueLabel(item: Pick<OpenDueItem, 'dueBasis' | 'dueDate' | 'dueMileage'>): string {
  const miles = item.dueMileage != null ? `${item.dueMileage.toLocaleString('en-GB')} miles` : 'a mileage';
  switch (item.dueBasis) {
    case 'date': return item.dueDate ? `due by ${item.dueDate}` : 'due by a date';
    case 'mileage': return `due at ${miles}`;
    case 'next_service': return 'due at the next service';
    // The label needs NO RATE — it states both legs, exactly as the garage wrote it. Only ORDERING
    // needs a projection, and that is effectiveDueDate's job.
    case 'whichever_first': return `due at ${miles} or by ${item.dueDate ?? 'a date'}, whichever comes first`;
  }
}

// ── ORDERING: WHEN IS THIS ACTUALLY DUE? ─────────────────────────────────────────────────────────
export type DueProjection =
  | { ok: true; date: Date; binding: 'date' | 'mileage'; mileageLegUnevaluated?: boolean }
  | { ok: false; reason: 'next_service' | 'no_rate' | 'no_date' };

/**
 * The date an item should surface on, or a STATED reason there isn't one.
 *
 * `whichever_first` is the interesting case and the reason this function exists. With a rate, the
 * earlier of (the date, the projected mileage date) binds — which is the whole meaning of the
 * phrase. WITHOUT a rate the mileage leg cannot be evaluated, and the honest answer is not "no
 * date": the written date still BOUNDS it, so it is returned with `mileageLegUnevaluated` set. A
 * caller can then remind at the date (late if the mileage would have come first) while knowing the
 * figure is a ceiling rather than the answer — which is better than surfacing nothing at all.
 */
export function effectiveDueDate(
  item: { dueBasis: DueBasis; dueDate: Date | null; dueMileage: number | null },
  ctx: { currentMiles: number | null; project: (targetMiles: number) => Date | null },
): DueProjection {
  switch (item.dueBasis) {
    case 'next_service':
      // Tied to a visit, not a clock. Not a failure — a different kind of trigger.
      return { ok: false, reason: 'next_service' };
    case 'date':
      return item.dueDate ? { ok: true, date: item.dueDate, binding: 'date' } : { ok: false, reason: 'no_date' };
    case 'mileage': {
      if (item.dueMileage == null) return { ok: false, reason: 'no_date' };
      const p = ctx.project(item.dueMileage);
      return p ? { ok: true, date: p, binding: 'mileage' } : { ok: false, reason: 'no_rate' };
    }
    case 'whichever_first': {
      if (!item.dueDate || item.dueMileage == null) return { ok: false, reason: 'no_date' };
      const p = ctx.project(item.dueMileage);
      if (!p) return { ok: true, date: item.dueDate, binding: 'date', mileageLegUnevaluated: true };
      return p.getTime() < item.dueDate.getTime()
        ? { ok: true, date: p, binding: 'mileage' }
        : { ok: true, date: item.dueDate, binding: 'date' };
    }
  }
}

// ── THE PRINTED BLOCK ────────────────────────────────────────────────────────────────────────────
/**
 * The lines that go on the invoice — and, frozen, into Invoice.due_items_snapshot at mint.
 *
 * ── WHY THE MOT EXPIRY IS IN HERE ───────────────────────────────────────────────────────────────
 * Because the garage prints it, and because it is the one line nobody should have to type: it is
 * DVSA-sourced on the vehicle. It leads the block, as it does on the real invoices this replaces.
 *
 * ── AND WHY IT MUST BE FROZEN WITH THE REST ─────────────────────────────────────────────────────
 * The MOT expiry MOVES the moment the car is retested. Rendering it live would print next year's
 * date against last year's invoice — quieter than a changing findings list and just as wrong. A
 * customer holding June's invoice must be able to hold it up against a reprint and see the same
 * page.
 *
 * Numbered, one per line, exactly as a garage writes them by hand.
 */
export function printedDueItemsBlock(args: {
  motExpiry: Date | null;
  items: Array<Pick<OpenDueItem, 'description' | 'dueBasis' | 'dueDate' | 'dueMileage'>>;
  /** Pre-rendered tyre lines (lib/tyres::printedTyreLines). TEXT, so they freeze like the rest. */
  tyreLines?: string[];
  /** The battery test (lib/battery::printedBatteryLine), same argument. NULL when none was taken —
   *  and null rather than an empty string, so "not tested" is distinguishable from "tested, nothing
   *  to say". A battery advisory arrives separately, via `items`, like every other finding. */
  batteryLine?: string | null;
}): string | null {
  const lines: string[] = [];
  if (args.motExpiry) {
    lines.push(`MOT Expiry ${args.motExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`);
  }
  for (const it of args.items) lines.push(`${it.description} ${dueLabel(it)}`);
  // TYRES AS TEXT, deliberately — a four-corner table would print prettier and freeze worse. The
  // invoice is a document and what matters is that it reprints identically (the B(iii) argument).
  for (const t of args.tyreLines ?? []) lines.push(t);
  // The MEASUREMENT, after the tyres. Its ADVISORY, if it raised one, is already above among the
  // findings — this line is the evidence, printed once, where a customer can check it.
  if (args.batteryLine) lines.push(args.batteryLine);
  // NULL, not an empty string: nothing to say is not the same as a block that printed empty, and a
  // reader of the column can tell them apart.
  if (!lines.length) return null;
  return lines.map((l, i) => `(${i + 1}) ${l}`).join('\n');
}

// ── THE CUSTOMER'S OWN ANSWER ────────────────────────────────────────────────────────────────────
export type CustomerAnswer = 'yes' | 'no' | 'call_me';

/**
 * How a customer's tap lands on the GARAGE's field.
 *
 * "Yes" is INTEREST, NOT ACCEPTANCE — the report carries no prices, so a yes means "quote me for
 * this", and the estimate still goes out and comes back through acceptQuote like any other. That is
 * why yes maps to `agreed_later` and never to anything that reads as agreement to a figure.
 */
export const GARAGE_VIEW_OF: Record<CustomerAnswer, 'declined' | 'agreed_later' | 'wants_call'> = {
  yes: 'agreed_later',
  no: 'declined',
  call_me: 'wants_call',
};

export type AnswerDivergence = {
  /** What the customer themselves last tapped. */
  customer: CustomerAnswer;
  customerAt: string;
  /** What the garage will act on — may be newer, set by someone who took a phone call. */
  garage: DueItemResponse;
  /** True when the garage has since recorded something the customer did not say. */
  diverged: boolean;
};

/**
 * Do the two records disagree, and how?
 *
 * PURE, and deliberately NOT an error: a divergence is the normal shape of "they tapped no, then
 * rang and changed their mind". It exists to be SHOWN — inline beside the field when someone is
 * about to override, and permanently on the finding afterwards — never to fire an alert. The person
 * who creates a divergence is the person doing it deliberately, and notifying them about their own
 * action is the noise that stops escalations being read.
 */
export function answerDivergence(
  latest: { answer: CustomerAnswer; answeredAt: Date } | null,
  garage: DueItemResponse,
): AnswerDivergence | null {
  if (!latest) return null;
  return {
    customer: latest.answer,
    customerAt: latest.answeredAt.toISOString(),
    garage,
    diverged: GARAGE_VIEW_OF[latest.answer] !== garage,
  };
}

/**
 * RECORD A CUSTOMER'S ANSWER — the one writer, so the two records can never be written apart.
 *
 * Two writes, one transaction:
 *   1. APPEND to DueItemCustomerAnswer. Never updated: a customer who changes their mind on the
 *      same report leaves two rows in order, and the history of what they actually tapped survives.
 *   2. WRITE THROUGH to the garage's field, because the office needs one field to read. A later
 *      staff edit overrides it — last write wins on the garage side only.
 *
 * `response_at` is stamped here for the same reason it is stamped anywhere: an ANSWER is an event.
 * (`not_raised` is the only value that leaves it null, and a customer answer can never produce it.)
 */
export async function recordCustomerAnswer(
  tx: Prisma.TransactionClient,
  args: { groupId: string; dueItemId: string; answer: CustomerAnswer; magicLinkId: string | null; at: Date },
): Promise<{ garageResponse: DueItemResponse }> {
  const garageResponse = GARAGE_VIEW_OF[args.answer];
  await (tx as Prisma.TransactionClient).dueItemCustomerAnswer.create({
    data: {
      group_id: args.groupId,
      due_item_id: args.dueItemId,
      answer: args.answer,
      answered_at: args.at,
      magic_link_id: args.magicLinkId,
    },
  });
  await (tx as Prisma.TransactionClient).vehicleDueItem.update({
    where: { id: args.dueItemId },
    data: { customer_response: garageResponse, response_at: args.at },
  });
  return { garageResponse };
}

/** The customer's LATEST tap per finding — what the divergence check and the screens read. */
export async function latestCustomerAnswers(
  db: Prisma.TransactionClient | { dueItemCustomerAnswer: { findMany: (a: unknown) => Promise<unknown> } },
  dueItemIds: string[],
): Promise<Map<string, { answer: CustomerAnswer; answeredAt: Date }>> {
  if (!dueItemIds.length) return new Map();
  const rows = (await (db as { dueItemCustomerAnswer: { findMany: (a: unknown) => Promise<unknown> } }).dueItemCustomerAnswer.findMany({
    where: { due_item_id: { in: dueItemIds } },
    orderBy: { answered_at: 'asc' },   // ascending, so the last write into the map is the newest
    select: { due_item_id: true, answer: true, answered_at: true },
  })) as Array<{ due_item_id: string; answer: CustomerAnswer; answered_at: Date }>;
  const out = new Map<string, { answer: CustomerAnswer; answeredAt: Date }>();
  for (const r of rows) out.set(r.due_item_id, { answer: r.answer, answeredAt: r.answered_at });
  return out;
}

// ── "AWAITING RESPONSE" — DERIVED, NEVER AN EVENT ────────────────────────────────────────────────
export type ReportStatus =
  | { state: 'not_sent' }
  | { state: 'awaiting'; sentAt: string; days: number; answered: number; total: number }
  | { state: 'partial'; sentAt: string; days: number; answered: number; total: number }
  | { state: 'all_answered'; sentAt: string; answered: number };

/**
 * Where a card's intake report stands.
 *
 * NO RESPONSE IS NOT AN EVENT. Nothing happened, so nothing can fire — building it as a
 * notification would mean inventing an event from an absence and then deciding how often to nag.
 * It is derived from two facts the system already holds: when a report link was last minted, and
 * how many findings carry a customer answer. A card shows "sent 3 days ago, no reply" without any
 * scheduled job, and the figure cannot drift because nothing stores it.
 */
export function reportStatus(args: {
  lastSentAt: Date | null;
  totalFindings: number;
  answeredFindings: number;
  now: Date;
}): ReportStatus {
  if (!args.lastSentAt) return { state: 'not_sent' };
  const sentAt = args.lastSentAt.toISOString();
  const days = Math.floor((args.now.getTime() - args.lastSentAt.getTime()) / 86_400_000);
  if (args.totalFindings > 0 && args.answeredFindings >= args.totalFindings) {
    return { state: 'all_answered', sentAt, answered: args.answeredFindings };
  }
  const shape = args.answeredFindings > 0 ? 'partial' : 'awaiting';
  return { state: shape, sentAt, days, answered: args.answeredFindings, total: args.totalFindings };
}

// ── CLOSURE: DERIVED AND OFFERED, NEVER AUTOMATIC ────────────────────────────────────────────────
export type ClosureOffer =
  | { offer: false; reason: 'no_lines' | 'work_outstanding' }
  | { offer: true; invoicedLines: number };

/**
 * Should the card OFFER to close this finding?
 *
 * ── THE CASE THIS EXISTS FOR ────────────────────────────────────────────────────────────────────
 * A customer says yes to discs and pads. The garage fits the discs today and the pads next month.
 * One invoice is issued, one finding is genuinely finished, one is not. A rule that closed findings
 * on invoice would clear both — silently, and in the direction that loses agreed work.
 *
 * So: every linked line must sit on an ISSUED invoice before the offer appears, and even then it is
 * an OFFER. A person confirms. The prompt does the remembering; the judgement stays human.
 *
 * PURE, so the rule is provable without issuing anything.
 */
export function closureOffer(lines: Array<{ invoiceIssued: boolean }>): ClosureOffer {
  if (!lines.length) return { offer: false, reason: 'no_lines' };
  const invoiced = lines.filter((l) => l.invoiceIssued).length;
  // PARTIAL IS NOT DONE. This single comparison is the discs-and-pads case.
  if (invoiced < lines.length) return { offer: false, reason: 'work_outstanding' };
  return { offer: true, invoicedLines: invoiced };
}

/** Findings on a card with their linked lines' invoice state — the closure prompt's input. */
export async function closureOffersForCard(
  db: Prisma.TransactionClient | { dueItemLine: { findMany: (a: unknown) => Promise<unknown> } },
  groupId: string,
  dueItemIds: string[],
): Promise<Map<string, ClosureOffer>> {
  const out = new Map<string, ClosureOffer>();
  if (!dueItemIds.length) return out;
  const rows = (await (db as { dueItemLine: { findMany: (a: unknown) => Promise<unknown> } }).dueItemLine.findMany({
    where: { group_id: groupId, due_item_id: { in: dueItemIds } },
    select: { due_item_id: true, job_card_item: { select: { job_card: { select: { invoice: { select: { issued_at: true } } } } } } },
  })) as Array<{ due_item_id: string; job_card_item: { job_card: { invoice: { issued_at: Date | null } | null } } }>;
  const byItem = new Map<string, Array<{ invoiceIssued: boolean }>>();
  for (const r of rows) {
    const issued = !!r.job_card_item?.job_card?.invoice?.issued_at;
    byItem.set(r.due_item_id, [...(byItem.get(r.due_item_id) ?? []), { invoiceIssued: issued }]);
  }
  for (const id of dueItemIds) out.set(id, closureOffer(byItem.get(id) ?? []));
  return out;
}
