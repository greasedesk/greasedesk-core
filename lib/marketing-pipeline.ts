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
  | 'mot_expired' | 'battery_replace' | 'tyre_illegal' | 'agreed_not_booked' | 'service_overdue' | 'wants_call'
  | 'quote_expired' | 'quote_open'
  | 'mot_due' | 'service_due' | 'unanswered' | 'battery_retest'
  | 'declined' | 'snoozed' | 'distant';

/** The set, as VALUES — MarketingContact.reason is checked against exactly this, in the database
 *  and at the endpoint, so a contact can say what the call was really about. */
export const LEAD_REASON_KINDS: LeadReasonKind[] = [
  'mot_expired', 'battery_replace', 'tyre_illegal', 'agreed_not_booked', 'service_overdue', 'wants_call',
  'quote_expired', 'quote_open',
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
  findings: Array<{ description: string; response: 'not_raised' | 'declined' | 'agreed_later' | 'wants_call'; dueWithinWindow: boolean; overdue?: boolean }>;
  /** The garage's last contact record for this car, if any. */
  /**
   * Does the contact record STILL HOLD? True → the garage's answer is current and the car sits in
   * Later. False → whatever they said has outlived the thing it was about, and the signals speak
   * again. Named for the state that TRIGGERS the demotion, so the guard below reads without a
   * negation — the previous name (`spent`) meant the opposite of the expression assigned to it,
   * and the two `!`s cancelled into a decline that did nothing. See lib/marketing-lists.
   */
  contact: { state: 'contacted' | 'booked' | 'declined' | 'snoozed'; snoozeUntil: Date | null; contactStands: boolean } | null;
  /**
   * Days to the nearest SERVICE trigger, signed (negative = already passed). NULL when the car has
   * no dated service hit — including a trigger-band item like "due at the next service", which is
   * a real reason with no clock to read. Supplied by the board because the dates live on the due
   * items; motDays above is the same fact for the MOT.
   */
  serviceDueDays?: number | null;
  /**
   * THE OLDEST QUOTE THAT LAPSED WITH NO ANSWER, and what it was worth. NULL when nothing was sent,
   * when every sent quote was answered, or when the card has since closed.
   *
   * THE FACT, NOT THE DERIVATION — no sent_at, no status, no MAGIC_LINK_DAYS here. The board asks
   * lib/quotes-list::deriveQuoteStatus what "expired" means, exactly as the Quotes tab does, so the
   * two surfaces cannot disagree about which quotes have lapsed. Same discipline as motBand.
   *
   * `alsoLapsed` is how many OTHER quotes on this car have lapsed, so the row can name the oldest
   * and count the rest rather than listing them.
   */
  /**
   * NO MONEY HERE, and that is a decision rather than an omission. The value is the sharpest thing
   * about this lead — but marketing-board-gate holds the board to carrying no money FIELD at all
   * ("not a gated field — no field. There is nothing to leak"), written after the board rendered
   * £1,214 to a STANDARD mechanic with no check. reason.text renders unconditionally, so a figure
   * in the sentence is that leak wearing different clothes. Putting the value back means routing
   * the board through financeVisibility, which is its own slice.
   */
  quote?: { kind: 'live' | 'expired' | 'verbal'; ageDays: number; alsoLapsed: number } | null;
  /**
   * DAYS TO EXPIRY, signed: positive while the quote is live, negative once it has lapsed. NULL for
   * a VERBAL quote, which has no sent_at and therefore no expiry to count to — exactly the shape
   * motDays and serviceDueDays already use, and the reason urgencyOf returns URGENCY_NO_CLOCK for
   * it without a new constant.
   */
  quoteDays?: number | null;
  /** Group.marketing_expired_quotes. Default TRUE — an off switch, not an opt-in. */
  showExpiredQuotes?: boolean;
  /** Group.marketing_quote_hot_days. NULL = only on expiry. */
  quoteHotDays?: number | null;
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
  // ── THEY ASKED TO BE RUNG ────────────────────────────────────────────────────────────────────
  // `wants_call` was in the type union and nowhere else: not in `agreed`, not in `unanswered`, not
  // in `declined`. The one answer that literally means "ring me" produced no reason at all, and
  // survived into the board only if its finding happened to fall in the due window. It was
  // unreachable in practice — only the customer report can set it, and one report has ever been
  // sent — so nothing caught it.
  //
  // It belongs in the MEASURED band with the failed batteries and the illegal tyre, and for the
  // same reason: it is knowledge, not a calendar. Somebody said the words.
  //
  // It is not in DATED_KINDS, so on a car whose only reason is this one, urgencyOf returns 0 and it
  // ranks above every clock — where a customer who asked to be phoned belongs. On a car that ALSO
  // has an MOT date the nearest clock still decides, exactly as it does for a failed battery: the
  // measured band is what a row falls back to when nothing on it is dated, not an override.
  const wantsCall = s.findings.filter((f) => f.response === 'wants_call');
  if (wantsCall.length) {
    out.push({ kind: 'wants_call', stack: 'hot',
      text: `${plural(wantsCall.length, 'job', 'jobs')} they asked to be called about — ${wantsCall[0].description}` });
  }
  // ── THEY ASKED THE PRICE AND NEVER ANSWERED ──────────────────────────────────────────────────
  // The best lead on the board: you know what they wanted, you know what it costs, and they never
  // said no. It belongs beside agreed_not_booked — the same shape one step earlier.
  //
  // NOT IN DATED_KINDS, deliberately, so urgencyOf returns URGENCY_MEASURED and it ranks above
  // every clock. An expired quote has no clock AHEAD of it, only one behind: its age says how cold
  // the lead has gone, not when something becomes urgent. A quote that lapsed 17 days ago is not
  // more urgent than one that lapsed 8 days ago — the same argument the file already makes for
  // wants_call, which is knowledge rather than a calendar.
  if (s.quote) {
    const q = s.quote;
    const lapsed = q.kind === 'expired';
    const more = q.alsoLapsed > 0 ? ` (${q.alsoLapsed} more lapsed)` : '';
    // THE SWITCH IS ABOUT LAPSED QUOTES, not about quoting: a garage that turns it off still sees
    // its live quotes. Off means "do not chase the ones that ran out", which is the only thing a
    // garage would actually want to silence.
    const suppressed = lapsed && s.showExpiredQuotes === false;
    // EARLY PROMOTION. marketing_quote_hot_days is days BEFORE expiry at which a live quote goes
    // Hot; null means only on expiry, which degenerates to exactly the behaviour that shipped.
    const early = !lapsed && q.kind === 'live' && s.quoteHotDays != null
      && s.quoteDays != null && s.quoteDays <= s.quoteHotDays;
    if (!suppressed) {
      // FOUR STATES, FOUR SENTENCES — and each says the thing that makes it actionable. Three-way
      // day wording throughout, because "0 days ago" and "1 days" are not sentences.
      const ago = (n: number) => (n === 0 ? 'today' : `${plural(n, 'day', 'days')} ago`);
      const text = q.kind === 'verbal'
        ? `Quoted verbally ${ago(q.ageDays)} — never sent`
        : lapsed
          ? `Quote expired ${ago(Math.abs(Math.round(s.quoteDays ?? 0)))} — they never said no${more}`
          : early
            ? `Quote expires in ${plural(Math.round(s.quoteDays as number), 'day', 'days')} — no answer yet${more}`
            : `Quote sent ${ago(q.ageDays)} — no answer yet${more}`;
      // ── THE KIND IS THE QUOTE'S STATE; THE STACK IS ITS URGENCY ────────────────────────────
      // Two axes, kept independent. An early-promoted live quote is Hot and still OPEN, so it is
      // quote_open in the hot stack — one kind spanning both states meant a garage ringing about a
      // quote sent yesterday had the call recorded as `quote_expired`. The behaviour was right and
      // the label was a lie, which is the kind of wrong that survives: nothing looks broken and the
      // contact history quietly stops meaning what it says.
      out.push({ kind: lapsed ? 'quote_expired' : 'quote_open', stack: lapsed || early ? 'hot' : 'warm', text });
    }
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
  // ── PAST IT IS HOT; COMING UP IS WARM ────────────────────────────────────────────────────────
  // Exactly the pair this file already draws for the MOT — mot_expired Hot, mot_due Warm — and it
  // was missing here only because serviceDue dropped `alreadyPassed`, so nothing downstream could
  // see the difference. A car months past its service is not a car due in three weeks, and it was
  // sitting in the same stack.
  // wants_call is excluded here too: it already has its own reason above, and a car should not
  // read "1 job due" AND "1 job they asked to be called about" for the same finding — the same
  // duplication the battery had on the invoice, the card and this row.
  const live = s.findings.filter((f) => f.dueWithinWindow && f.response !== 'declined' && f.response !== 'wants_call');
  const overdue = live.filter((f) => f.overdue);
  const dueSoon = live.filter((f) => !f.overdue);
  if (overdue.length) {
    out.push({ kind: 'service_overdue', stack: 'hot',
      text: `${plural(overdue.length, 'job', 'jobs')} overdue — ${overdue[0].description}` });
  }
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
/**
 * ── URGENCY: A NUMBER THAT EXISTS FOR EVERY ROW ────────────────────────────────────────────────
 * LOWER RINGS SOONER. Ascending is the useful direction, so the sharpest lead is first.
 *
 * Two bands, and the boundary is the point:
 *
 *   0            A MEASURED FAULT — a failed battery, an illegal tyre, a finding nobody has put
 *                to the customer. The car has been in and somebody looked at it. That outranks
 *                every clock, because it is knowledge rather than a calendar.
 *   1 + |days|   A CLOCK, unsigned. A car expiring tomorrow and one that expired yesterday sit
 *                next to each other, which is the honest ranking: both are AT the boundary. A car
 *                144 days expired is a cold lead and sinks accordingly — distance from now in
 *                either direction is distance from the moment worth ringing about.
 *   99_999       A dated reason with NO clock ("due at the next service"). Sorts last among dated
 *                rather than first: we do not know when, and not knowing must not jump the queue.
 *
 * Ties are real and left alone — every measured fault is 0, and stable sort keeps them in the
 * order they were emitted. Ranking a battery against a tyre would be inventing a clinical
 * judgement this file has no basis for.
 */
export const URGENCY_MEASURED = 0;
export const URGENCY_NO_CLOCK = 99_999;
const DATED_KINDS = new Set<LeadReasonKind>(['mot_expired', 'mot_due', 'service_due', 'service_overdue', 'quote_expired', 'quote_open']);

export function urgencyOf(reasons: LeadReason[], s: LeadSignals): number {
  const dated = reasons.filter((r) => DATED_KINDS.has(r.kind));
  if (!dated.length) return URGENCY_MEASURED;
  const clocks: number[] = [];
  if (dated.some((r) => r.kind === 'mot_expired' || r.kind === 'mot_due') && s.motDays != null) clocks.push(s.motDays);
  if (dated.some((r) => r.kind === 'service_due' || r.kind === 'service_overdue') && s.serviceDueDays != null) clocks.push(s.serviceDueDays);
  // A QUOTE'S CLOCK RUNS BOTH WAYS: to expiry while it is live, since expiry once it has lapsed.
  // Math.abs below collapses the two, which is safe only because the STACK is decided first —
  // everything Warm is ahead of its expiry and everything Hot is past it, so the two can never
  // meet inside one list.
  if (dated.some((r) => r.kind === 'quote_expired' || r.kind === 'quote_open') && s.quoteDays != null) clocks.push(s.quoteDays);
  if (!clocks.length) return URGENCY_NO_CLOCK;
  // The NEAREST clock decides: a car with two triggers is as urgent as its soonest one.
  return 1 + Math.round(Math.min(...clocks.map((d) => Math.abs(d))));
}

export function leadStack(s: LeadSignals, now: Date = new Date()): { stack: Stack; reasons: LeadReason[]; urgency: number } {
  const reasons = leadReasons(s, now);

  // A LIVE SNOOZE OR DECLINE OUTRANKS EVERYTHING, while the record still holds. Whether it does is
  // lib/marketing-lists::contactStands' job — once the trigger it was about has passed, the record
  // stops applying and the signal speaks again. That is the clock coming round, and it needs
  // nothing scheduled.
  const c = s.contact;
  // ── A DECLINE IS TERMINAL; A SNOOZE EXPIRES ──────────────────────────────────────────────────
  // "No" and "not right now" were treated as one thing, spending after the same window, so a
  // customer who declined was rung again a month later by a board that had forgotten. They are
  // different sentences: "ask me later" HAS a later, and "no" does not.
  //
  // So `contactStands` is not consulted for a decline: no clock, no dueDate, no age. That also
  // means the `!current.dueDate` branch inside isUnactioned no longer governs declines at all —
  // it still governs snoozes and bookings, and is deliberately left in place.
  //
  // The way back is the garage's, not the clock's: record a different outcome against the car.
  // Nothing here sweeps or expires it, which is the point.
  if (c && c.state === 'declined') {
    return { stack: 'later', reasons: [{ kind: 'declined', stack: 'later', text: 'Contacted — not this time' }, ...reasons], urgency: urgencyOf(reasons, s) };
  }
  if (c && c.contactStands) {
    if (c.state === 'booked') return { stack: 'later', reasons: [{ kind: 'snoozed', stack: 'later', text: 'Booked in' }, ...reasons], urgency: urgencyOf(reasons, s) };
    if (c.state === 'snoozed' && c.snoozeUntil && c.snoozeUntil > now) {
      return { stack: 'later', reasons: [{ kind: 'snoozed', stack: 'later', text: `Snoozed until ${c.snoozeUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` }, ...reasons], urgency: urgencyOf(reasons, s) };
    }
  }

  const urgency = urgencyOf(reasons, s);
  if (reasons.some((r) => r.stack === 'hot')) return { stack: 'hot', reasons, urgency };
  if (reasons.some((r) => r.stack === 'warm')) return { stack: 'warm', reasons, urgency };
  return { stack: 'later', reasons, urgency };
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
