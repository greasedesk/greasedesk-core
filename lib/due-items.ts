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

export type DueBasis = 'date' | 'mileage' | 'next_service';
export type DueItemResponse = 'not_raised' | 'declined' | 'agreed_later';

export type DueItemRefusal = { code: string; message: string };

export type DueItemInput = {
  description: string;
  dueBasis: DueBasis | null | undefined;
  dueDate?: Date | null;
  dueMileage?: number | null;
  customerResponse: DueItemResponse | null | undefined;
};

const BASES: readonly DueBasis[] = ['date', 'mileage', 'next_service'];
const RESPONSES: readonly DueItemResponse[] = ['not_raised', 'declined', 'agreed_later'];

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
  switch (item.dueBasis) {
    case 'date': return item.dueDate ? `due by ${item.dueDate}` : 'due by a date';
    case 'mileage': return item.dueMileage != null ? `due at ${item.dueMileage.toLocaleString('en-GB')} miles` : 'due at a mileage';
    case 'next_service': return 'due at the next service';
  }
}
