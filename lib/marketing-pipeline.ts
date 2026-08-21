/**
 * File: lib/marketing-pipeline.ts
 * WHICH STACK A CAR IS IN, AND WHY — the marketing board as a pipeline rather than a list.
 *
 *   Hot    money available this week. They will say yes.
 *   Warm   due within the window, plausible, not urgent.
 *   Later  declined, snoozed, or genuinely distant.
 *
 * ── COMPUTED, NEVER STORED ──────────────────────────────────────────────────────────────────────
 * There is no `stack` column and there must not be one. Every input is a stored DATE or a stored
 * READING compared against `now`, so time promotes for free: an MOT thirty-one days out is Warm at
 * four o'clock and Hot tomorrow morning, with no job to run and nothing to sweep. A stored stack is
 * wrong between writes and needs something to notice — which is the whole failure this shape
 * avoids. Same derived-not-stamped rule as the tab spine and the due-item bands.
 *
 * ── THE MOVEMENT RULE IS WHAT STOPS HOT BECOMING A GRAVEYARD ────────────────────────────────────
 * A hot lead that was contacted and declined drops to Later WITH ITS DATE, and returns when its
 * clock comes round — MarketingContact.snooze_until and for_date, both read at query time. Nothing
 * stays at the top because nobody dealt with it; it stays at the top because it is still true.
 *
 * ── A RETEST IS NOT A SALE, AND SITS APART ──────────────────────────────────────────────────────
 * lib/battery's `retest` state is a REFUSAL: low charge and low health together, where the code
 * declines to guess because "we cannot tell a dying battery from a flat one, and guessing in the
 * direction of a sale is the guess that costs trust". It is a real lead and real money — the same
 * phone call — but a different sentence, and it must never sit beside a confirmed sale. Warm, with
 * its own wording, and `kind: 'retest'` so no surface can render it as "you need a battery".
 *
 * ── NO VALUE MODEL ──────────────────────────────────────────────────────────────────────────────
 * Deliberately. The board it replaces showed "£1,214" — four cars times the tenant's average job,
 * a figure describing none of them. A COUNT is true. Get the ordering right and the money becomes
 * obvious; a value model built before the ordering is a forecast nobody made.
 */
import { LEGAL_MIN_TENTHS } from '@/lib/tyres';
import type { BatteryState } from '@/lib/battery';

export type Stack = 'hot' | 'warm' | 'later';

/**
 * WHY a car is where it is. The board shows this, so it is authored here rather than assembled in
 * a component — one place to read when somebody asks why a car is at the top.
 */
export type LeadReasonKind =
  | 'mot_expired' | 'battery_replace' | 'tyre_illegal' | 'agreed_not_booked'
  | 'mot_due' | 'service_due' | 'unanswered' | 'battery_retest'
  | 'declined' | 'snoozed' | 'distant';

/** The set, as VALUES — MarketingContact.reason is checked against exactly this, in the database
 *  and at the endpoint, so a contact can say what the call was really about. */
export const LEAD_REASON_KINDS: LeadReasonKind[] = [
  'mot_expired', 'battery_replace', 'tyre_illegal', 'agreed_not_booked',
  'mot_due', 'service_due', 'unanswered', 'battery_retest',
  'declined', 'snoozed', 'distant',
];

export type LeadReason = { kind: LeadReasonKind; stack: Stack; text: string };

/** The signals, all of them already stored. Nothing here is inferred from another surface. */
export type LeadSignals = {
  /** lib/marketing-lists::motBand against now. */
  motBand: 'expired' | 'due' | null;
  /** Days until the MOT runs out; negative when it already has. NULL when we hold no date. */
  motDays: number | null;
  /** lib/battery::batteryState for the car's latest test. NULL when never tested. */
  battery: BatteryState | null;
  /** The lowest single tread reading on the car, in tenths. NULL when no tyre has been measured. */
  lowestTreadTenths: number | null;
  /** Open findings, with what the customer said. */
  findings: Array<{ description: string; response: 'not_raised' | 'declined' | 'agreed_later' | 'wants_call'; dueWithinWindow: boolean }>;
  /** The garage's last contact record for this car, if any. */
  contact: { state: 'contacted' | 'booked' | 'declined' | 'snoozed'; snoozeUntil: Date | null; spent: boolean } | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * EVERY reason a car qualifies, strongest first. Not just the winning one: a car with an expired
 * MOT AND a failed battery is a better call than one with either, and the person ringing should be
 * able to say both.
 */
export function leadReasons(s: LeadSignals, now: Date = new Date()): LeadReason[] {
  const out: LeadReason[] = [];

  // ── HOT ──────────────────────────────────────────────────────────────────────────────────────
  if (s.motBand === 'expired') {
    // "expired 0 days ago" is what a rounding produces and not what anybody says. A car whose MOT
    // runs out today is a different sentence from one that lapsed in March, and both are hot.
    const days = s.motDays == null ? null : Math.abs(Math.round(s.motDays));
    out.push({ kind: 'mot_expired', stack: 'hot',
      text: days == null ? 'MOT expired'
        : days === 0 ? 'MOT expires today — off the road tomorrow'
        : `MOT expired ${plural(days, 'day', 'days')} ago — off the road` });
  }
  // dead_cell and replace only. `monitor` is a note, `charging_fault` is not the battery, and
  // `retest` is the refusal — all three are handled below or not at all.
  if (s.battery === 'dead_cell') out.push({ kind: 'battery_replace', stack: 'hot', text: 'Battery — a cell has failed' });
  if (s.battery === 'replace') out.push({ kind: 'battery_replace', stack: 'hot', text: 'Battery — failed the test' });
  if (s.lowestTreadTenths != null && s.lowestTreadTenths < LEGAL_MIN_TENTHS) {
    out.push({ kind: 'tyre_illegal', stack: 'hot', text: `Tyre at ${(s.lowestTreadTenths / 10).toFixed(1)}mm — below the legal limit` });
  }
  const agreed = s.findings.filter((f) => f.response === 'agreed_later');
  if (agreed.length) {
    out.push({ kind: 'agreed_not_booked', stack: 'hot',
      text: `${plural(agreed.length, 'job', 'jobs')} agreed and never booked — ${agreed[0].description}` });
  }

  // ── WARM ─────────────────────────────────────────────────────────────────────────────────────
  if (s.motBand === 'due') {
    const days = s.motDays == null ? null : Math.round(s.motDays);
    out.push({ kind: 'mot_due', stack: 'warm',
      text: days == null ? 'MOT due' : `MOT due in ${plural(days, 'day', 'days')}` });
  }
  // ITS OWN WORDING, and the reason is the whole point of the refusal it comes from: the car may
  // have an alternator fault, not a dying battery. "Get it back in" is the offer; a battery is not.
  if (s.battery === 'retest') {
    out.push({ kind: 'battery_retest', stack: 'warm', text: 'Battery test was inconclusive — get it back in and test it properly' });
  }
  if (s.battery === 'charging_fault') {
    out.push({ kind: 'battery_retest', stack: 'warm', text: 'Charging fault suspected — the battery held up, the charging did not' });
  }
  const dueSoon = s.findings.filter((f) => f.dueWithinWindow && f.response !== 'declined');
  if (dueSoon.length) {
    out.push({ kind: 'service_due', stack: 'warm', text: `${plural(dueSoon.length, 'job', 'jobs')} due — ${dueSoon[0].description}` });
  }
  const unanswered = s.findings.filter((f) => f.response === 'not_raised');
  if (unanswered.length) {
    out.push({ kind: 'unanswered', stack: 'warm',
      text: `${plural(unanswered.length, 'finding', 'findings')} nobody has put to the customer` });
  }

  // ── LATER ────────────────────────────────────────────────────────────────────────────────────
  const declined = s.findings.filter((f) => f.response === 'declined');
  if (declined.length) out.push({ kind: 'declined', stack: 'later', text: `${plural(declined.length, 'job', 'jobs')} the customer turned down` });

  return out;
}

/**
 * THE STACK. Strongest reason wins, then the CONTACT RECORD can only ever push a car DOWN.
 *
 * A snooze or a decline is the garage's own answer and must outrank the signal, or a declined
 * expired MOT climbs straight back to the top and the top becomes a graveyard. It pushes down and
 * never up: a car cannot be promoted by having been contacted.
 */
export function leadStack(s: LeadSignals, now: Date = new Date()): { stack: Stack; reasons: LeadReason[] } {
  const reasons = leadReasons(s, now);

  // A LIVE SNOOZE OR DECLINE OUTRANKS EVERYTHING. `spent` is lib/marketing-lists::isUnactioned's
  // job — once the trigger it was about has passed, the record stops applying and the signal
  // speaks again. That is the clock coming round, and it needs nothing scheduled.
  const c = s.contact;
  if (c && !c.spent) {
    if (c.state === 'booked') return { stack: 'later', reasons: [{ kind: 'snoozed', stack: 'later', text: 'Booked in' }, ...reasons] };
    if (c.state === 'declined') return { stack: 'later', reasons: [{ kind: 'declined', stack: 'later', text: 'Contacted — not this time' }, ...reasons] };
    if (c.state === 'snoozed' && c.snoozeUntil && c.snoozeUntil > now) {
      return { stack: 'later', reasons: [{ kind: 'snoozed', stack: 'later', text: `Snoozed until ${c.snoozeUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` }, ...reasons] };
    }
  }

  if (reasons.some((r) => r.stack === 'hot')) return { stack: 'hot', reasons };
  if (reasons.some((r) => r.stack === 'warm')) return { stack: 'warm', reasons };
  return { stack: 'later', reasons };
}

/**
 * ── WHAT THE BOARD SAYS ABOUT ITSELF ────────────────────────────────────────────────────────────
 * An empty Hot stack is not a quiet week — it is usually the answer nobody recorded. Every finding
 * on the live tenant is `not_raised`: nobody has asked the customer, so nothing can ever be
 * `agreed_later`, so the single hottest lead type in the model has no instances by construction.
 *
 * The board says this out loud rather than leaving a garage to work out why the top is empty. It
 * is the argument for recording the answer, and it belongs where the emptiness is visible.
 */
export function unansweredPrompt(hotCount: number, unansweredFindings: number): string | null {
  if (!unansweredFindings) return null;
  // ── ONE SENTENCE, NOT TWO VARIANTS ──────────────────────────────────────────────────────────
  // It used to lead with "Nothing hot right now" when Hot was empty. On the tabbed board the empty
  // Hot tab already says that, in the place a reader is looking, so the compound version said it
  // twice and buried the useful half.
  //
  // The pair now reads: "Nothing hot right now." / "12 findings are waiting on an answer — each yes
  // puts a car in Hot." The first states the position, the second says what changes it. That is the
  // whole job, and on an empty Hot tab those two lines are the entire screen — which is what turns
  // it from "this feature does nothing" into "here is what makes it work".
  //
  // "each yes puts a CAR in Hot", not "moves them": what moves is a car, and twelve findings are
  // spread across fewer cars than twelve.
  const n = unansweredFindings;
  return `${n} finding${n === 1 ? ' is' : 's are'} waiting on an answer — each yes puts a car in Hot.`;
}
