/**
 * File: lib/duplicate-cards.ts
 * IS THIS CAR ALREADY ON THE BOARD?
 *
 * LX13ZPO carried two open cards for four days. The diary's booking form takes a registration and a
 * customer name, POSTs to /api/jobcard, which find-or-creates the VEHICLE and then creates a card
 * unconditionally. Nothing asked whether that registration already had one. The two cards landed on
 * different lifts on different afternoons, so the board showed no collision: every photo, video,
 * reading and finding sat on the first, and the second held one £50 MOT line.
 *
 * ── "OPEN" IS ABOUT WORK, NOT ABOUT MONEY ───────────────────────────────────────────────────────
 * The question is "is there a live conversation or a live job for this car". It is NOT "does this
 * customer owe us anything", and the two must not be folded together — a warning that fires on
 * every unpaid invoice is a warning people learn to click through.
 *
 *   draft, quoted, accepted, in_progress → OPEN. Something is in flight: an unfinished intake, a
 *   quote awaiting an answer, booked work not started, a car in the bay. A second card splits it.
 *
 *   invoiced → NOT open. The work is finished and the bay is free; a car back next month is a new
 *   visit. refuseBayWrite already makes a frozen invoice the point a card stops accepting work, and
 *   a card you cannot record work against is not an open job. Unpaid is credit control's problem.
 *
 *   paid, done → finished.  declined, cancelled → over.
 *
 *   no_show → NOT open, and this is the one worth arguing. Rebooking someone who did not turn up is
 *   the most likely legitimate second card there is. Warning there would train people to dismiss the
 *   warning in exactly the case it exists for.
 */
import { statusSubset, type JobStatus } from '@/lib/jobcard-status';

/**
 * Statuses whose card means "this car is already on the board" — the DUPLICATE question.
 *
 * A total Record, like FREES_THE_SLOT and HIDDEN_FROM_DIARY: adding a status to the enum fails tsc
 * here until someone writes the decision. A bare array would compile fine and silently answer for
 * them, which is the whole failure this shape exists to prevent.
 */
export const OPEN_FOR_DUPLICATE: JobStatus[] = statusSubset({
  draft: true, quoted: true, accepted: true, in_progress: true,
  invoiced: false, paid: false, done: false,
  declined: false, cancelled: false,
  no_show: false, // rebooking a no-show is the commonest legitimate second card
});

/** What a warning needs to say WHICH card it means, without a second round trip. */
export type OpenCardSummary = {
  id: string;
  /** The booked day, or null when the card has no slot. YYYY-MM-DD. */
  bookedFor: string | null;
  /** When the card was made — the only date an unbooked card has. */
  createdOn: string;
  status: JobStatus;
  /** The lift's name, or null when the card is not in the diary at all. */
  lift: string | null;
  /**
   * Whether a document has been raised against it. Present so the reader can tell "still being
   * worked" from "finished and billed" without opening it — an open card with an invoice is the
   * unlocked-for-correction case, which is rare and worth seeing.
   */
  hasInvoice: boolean;
};

/** The row shape this needs, kept narrow so the caller's select is the contract. */
export type OpenCardRow = {
  id: string;
  created_at: Date;
  status: string;
  start_at: Date | null;
  resource: { name: string } | null;
  invoice: { id: string } | null;
};

/**
 * PURE. The invoice flag is asserted against this rather than end-to-end, because proving it
 * through the endpoint would mean fabricating an Invoice row on a live tenant to be read once.
 */
export function openCardSummary(row: OpenCardRow): OpenCardSummary {
  return {
    id: row.id,
    bookedFor: row.start_at ? row.start_at.toISOString().slice(0, 10) : null,
    createdOn: row.created_at.toISOString().slice(0, 10),
    status: row.status as JobStatus,
    // NULL, not "no lift": an unbooked card is still a duplicate, it just has no slot to name.
    lift: row.resource?.name ?? null,
    hasInvoice: row.invoice != null,
  };
}
