/**
 * File: lib/operator-alerts.ts
 * THE FOUR ALERTS THE OWNER ASKED FOR, AND THE RULES THAT MAKE THEM SAFE TO FIRE FROM A SIGNUP.
 *
 *   affiliate_joined   a person joined the programme — name, email, mobile, both verifications, code
 *   garage_registered  a garage signed up — name, contact, sites, the plan shape, and Came via
 *   garage_no_checkout registered an hour ago and never reached checkout — so it can be phoned
 *   first_payment      a trial became a paying customer — plan, amount, and who introduced them
 *
 * ── THREE PROMISES, AND EACH ONE IS A DESIGN DECISION ──────────────────────────────────────────
 *
 * 1. NEVER BLOCKS WHAT IT REPORTS. Every entry point here catches its own errors and returns an
 *    outcome; nothing throws out of `sendOperatorAlert`. A signup must not fail, and a Stripe
 *    webhook must not retry for ever, because an email to US did not go. The callers are already
 *    written that way (`markSignedUpByEmail`, attribution's second chance) and this joins them.
 *
 * 2. SENT ONCE. Idempotency is DERIVED FROM NotificationLog, not from a new table — every outcome
 *    of sendNotification writes a row there (sent, failed AND skipped), the table is indexed on
 *    (subject_type, subject_id), and a second table would be a second thing that can disagree with
 *    the first. The key is (template, subject, recipient): two recipients are two messages, and one
 *    of them failing must not mark the other as done.
 *
 *    SETTLED = any row whose status is not `failed`. A `skipped` row is a DELIBERATE non-send with
 *    its reason on it — not configured, the gate database, a contact preference — and re-attempting
 *    it would produce the identical refusal every hour for ever. A `failed` row is the provider
 *    rejecting it or the transport throwing, which is worth trying again: up to ATTEMPT_CAP rows
 *    per (alert, subject, recipient), then it stops and stays visible. Without the cap the hourly
 *    sweep would retry a permanently bad address twenty-four times a day.
 *
 * 3. A FAILURE IS VISIBLE. `recentAlerts` is read by /superadmin/billing, beside the field that
 *    sets the recipients — so "who gets these" and "did they arrive" are one screen. An alert that
 *    cannot be delivered is not a silent condition.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────────────────────────
 * No "alerts off" switch, and emptying the recipient list does not create one (see the column's
 * comment). No per-alert routing: one list answers one question, and four lists would be four
 * questions nobody has asked yet.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { sendNotification, PLATFORM_SEND } from '@/lib/notify';
import { alertRecipients as resolveRecipients } from '@/lib/platform-contact';
import { formatMoney } from '@/lib/format-money';
import { cameVia, referrerSentence } from '@/lib/came-via';
// The payloads are TEMPLATE DATA, which is strings and numbers only. Typed as that rather than as
// Record<string, unknown>: a template cannot render an object, and the compiler should say so here
// rather than printing "[object Object]" in an email to the owner.
import type { TemplateData } from '@/lib/notification-templates';

type Db = PrismaClient | Prisma.TransactionClient;

/** The four, as data. Enumerated from here by every reader — the screen, the sweep and the gate. */
export const OPERATOR_ALERTS = {
  affiliate_joined: { template: 'alert_affiliate_joined', subjectType: 'rep', label: 'A new affiliate joined' },
  garage_registered: { template: 'alert_garage_registered', subjectType: 'group', label: 'A garage registered' },
  garage_no_checkout: { template: 'alert_garage_no_checkout', subjectType: 'group', label: 'Registered, no checkout after an hour' },
  first_payment: { template: 'alert_first_payment', subjectType: 'group', label: 'A trial became a paying customer' },
} as const;

export type OperatorAlertKind = keyof typeof OPERATOR_ALERTS;
export const OPERATOR_ALERT_KINDS = Object.keys(OPERATOR_ALERTS) as OperatorAlertKind[];
export const ALERT_TEMPLATES = OPERATOR_ALERT_KINDS.map((k) => OPERATOR_ALERTS[k].template);

/** How many rows one (alert, subject, recipient) may ever produce. See promise 2 above. */
export const ATTEMPT_CAP = 3;

/**
 * HOW LONG AN INLINE SEND MAY HOLD UP THE THING IT REPORTS (owner, 2026-10-30).
 *
 * Three of these fire inside a request — a signup and a Stripe webhook. "It cannot FAIL the
 * signup" was true from the start; it could still SLOW one, because a provider that accepts
 * connections and then thinks about it for thirty seconds is a thirty-second signup. So the inline
 * calls are capped and the sweep picks up whatever the cap cut off.
 *
 * ── A TIMEOUT IS NOT A CANCELLATION, AND THAT IS WHY THIS IS SAFE ──────────────────────────────
 * Nothing is aborted: the send goes on in the background and, if it finishes, writes its own
 * NotificationLog row like any other. The sweep then reads that row and treats the alert as
 * settled, so a slow send produces ONE email, not two. This only works because idempotency is read
 * from the row the send itself writes rather than from a flag the caller sets — if the caller
 * marked it "sent" before the send returned, every timeout would be a lost alert, and if it marked
 * it afterwards, every timeout would be a duplicate.
 */
export const INLINE_TIMEOUT_MS = 3000;

/**
 * What a capped call answers. A WRAPPER with its own discriminant rather than a bare marker object:
 * AlertOutcome carries an optional `timedOut` of its own, so `'timedOut' in result` would not have
 * told the two apart — and a cast to make it read as if it did is where the compiler stops
 * checking. Two shapes, one boolean, nothing to narrow by accident.
 */
export type Capped<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Race an operation against the clock. `null` means no cap, which is what the sweep passes: it has
 * nothing waiting on it and a cap there would only hide a slow provider.
 *
 * The loser is NOT left to reject into the void — a rejection after we have stopped waiting is an
 * unhandled rejection, which in some runtimes takes the process down.
 */
export async function withCap<T>(work: Promise<T>, ms: number | null): Promise<Capped<T>> {
  if (ms == null) return { timedOut: false, value: await work };
  work.catch(() => {}); // see above: the loser must not reject unobserved
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<Capped<T>>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), clock]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How long after the fact the hourly sweep will still raise an alert. */
export const SWEEP_WINDOW_DAYS = 7;
/** How long a garage has to reach checkout before it becomes a phone call. */
export const NO_CHECKOUT_AFTER_MINUTES = 60;

// ── THE RECIPIENTS ─────────────────────────────────────────────────────────────────────────────
// Re-exported from the leaf that holds them, so a caller reads one name from one place. They live
// there because lib/programme-settings (the only writer of the column) has to validate a save, and
// importing this module to do it closed a runtime cycle through lib/notify.
export { refuseAlertEmails, alertRecipients, MAX_ALERT_RECIPIENTS } from '@/lib/platform-contact';

// ── IDEMPOTENCY ────────────────────────────────────────────────────────────────────────────────

export type AttemptRow = { status: string; recipient: string };

/** Settled for THIS recipient: a row exists that is not a failure. See promise 2. */
export function settledFor(rows: AttemptRow[], recipient: string): boolean {
  return rows.some((r) => r.recipient === recipient && r.status !== 'failed');
}
/** How many times we have tried THIS recipient — failures included, because they are the attempts. */
export function attemptsFor(rows: AttemptRow[], recipient: string): number {
  return rows.filter((r) => r.recipient === recipient).length;
}

/** Why a recipient was not written to this time, as a code. Null = go ahead. */
export function refuseAttempt(rows: AttemptRow[], recipient: string): 'already_sent' | 'attempts_exhausted' | null {
  if (settledFor(rows, recipient)) return 'already_sent';
  if (attemptsFor(rows, recipient) >= ATTEMPT_CAP) return 'attempts_exhausted';
  return null;
}

// ── THE SEND ───────────────────────────────────────────────────────────────────────────────────

export type AlertOutcome = {
  kind: OperatorAlertKind;
  subjectId: string;
  /** One entry per recipient: what happened, or why nothing did. */
  results: Array<{ recipient: string; action: 'sent' | 'failed' | 'skipped' | 'already_sent' | 'attempts_exhausted'; detail?: string }>;
  /** Set when the alert could not even be attempted — the subject vanished, the database refused. */
  error?: string;
  /**
   * The cap fired before the send answered. NOT a failure and NOT a success: the send is still
   * running, may still write its row, and the sweep will read whatever it finds. Three states, and
   * the middle one is the honest answer to "did that go?" — we do not know yet.
   */
  timedOut?: boolean;
};

/**
 * SEND ONE ALERT, ONCE, PER RECIPIENT. Never throws.
 *
 * `data` is the rendered payload for the template — strings, already formatted. The template does
 * no arithmetic and no date formatting; everything it prints was computed by one of the payload
 * builders below, so what the email says and what the screen says come from one place.
 */
export async function sendOperatorAlert(
  db: Db,
  args: { kind: OperatorAlertKind; subjectId: string; data: TemplateData; recipients?: string[] },
): Promise<AlertOutcome> {
  const alert = OPERATOR_ALERTS[args.kind];
  const outcome: AlertOutcome = { kind: args.kind, subjectId: args.subjectId, results: [] };
  try {
    const recipients = args.recipients ?? resolveRecipients(
      await (db as any).programmeSettings.findUnique({ where: { id: 'singleton' }, select: { alert_emails: true } }),
    );
    const rows: AttemptRow[] = await (db as any).notificationLog.findMany({
      where: { template: alert.template, subject_type: alert.subjectType, subject_id: args.subjectId },
      select: { status: true, recipient: true },
    });

    for (const recipient of recipients) {
      const refusal = refuseAttempt(rows, recipient);
      if (refusal) { outcome.results.push({ recipient, action: refusal }); continue; }
      const sent = await sendNotification({
        recipient,
        template: alert.template,
        channel: 'email',
        // PLATFORM_SEND: this is GreaseDesk writing to GreaseDesk. It is NOT the garage's message
        // even when it is about a garage, so it spends no tenant allowance and carries no tenant
        // scope — which the NotificationLog CHECK constraint enforces either way.
        groupId: PLATFORM_SEND,
        subject: { type: alert.subjectType, id: args.subjectId },
        data: args.data,
      });
      outcome.results.push({ recipient, action: sent.status, detail: sent.reason ?? sent.skipCode });
      // Keep the local view in step, so two identical recipients in one call cannot double-send.
      rows.push({ status: sent.status, recipient });
    }
  } catch (e) {
    // THE WHOLE POINT. A signup, a webhook or a cron calls this; none of them may fail because an
    // alert did. Logged loudly, because an alert nobody knows was lost is worse than a noisy log.
    outcome.error = e instanceof Error ? e.message : String(e);
    console.error(`[operator-alerts] ${args.kind} for ${args.subjectId} could not be attempted:`, e);
  }
  return outcome;
}

// ── THE PAYLOADS ───────────────────────────────────────────────────────────────────────────────

const when = (d: Date | null | undefined): string =>
  d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }) : 'not recorded';

/** "yes, 12 Aug 2026" / "no" — the WORD, because a tick and a blank cell read the same. */
const verified = (at: Date | null | undefined): string => (at ? `yes (${when(at)})` : 'no');

/**
 * A NEW AFFILIATE. The mobile and its verification come from TwoFactorSecret, which is where
 * confirmPhoneVerification writes them and nothing else does — not from a second copy on Rep.
 */
export async function affiliatePayload(db: Db, repId: string): Promise<TemplateData | null> {
  const rep = await (db as any).rep.findUnique({
    where: { id: repId },
    select: { name: true, email: true, email_verified_at: true, ref_code: true, social_handle: true, find_method: true, created_at: true },
  });
  if (!rep) return null;
  const phone = await (db as any).twoFactorSecret.findFirst({
    where: { subject_type: 'rep', subject_id: repId },
    select: { phone_e164: true, phone_verified_at: true },
  });
  return {
    name: rep.name,
    email: rep.email,
    mobile: phone?.phone_e164 ?? 'not given',
    smsVerified: verified(phone?.phone_verified_at),
    emailVerified: verified(rep.email_verified_at),
    refCode: rep.ref_code,
    socialHandle: rep.social_handle ?? 'not given',
    findMethod: rep.find_method ?? 'not given',
    joined: when(rep.created_at),
  };
}

/** The plan SHAPE a garage is on, from its latest frozen terms. Null = no terms row yet. */
async function planShape(db: Db, groupId: string): Promise<string> {
  const terms = await (db as any).tenantPlanTerms.findFirst({
    where: { group_id: groupId }, orderBy: { effective_from: 'desc' },
    select: { plan: true, paid_now_pennies: true },
  });
  if (!terms) return 'not recorded';
  const paid = terms.paid_now_pennies;
  return paid != null ? `${terms.plan} (${formatMoney(paid)} at signup)` : String(terms.plan);
}

/**
 * A GARAGE, AND WHERE IT CAME FROM. The three Came via axes are carried as three separate strings,
 * for the reason the screen keeps them apart: "nobody referred them" and "we don't know how they
 * heard of us" are different sentences, and only one of them is about money.
 */
export async function garagePayload(db: Db, groupId: string): Promise<TemplateData | null> {
  const g = await (db as any).group.findUnique({
    where: { id: groupId },
    select: {
      ref: true, group_name: true, trading_name: true, billing_email: true, phone: true, country_code: true,
      created_at: true, status: true, trial_ends_at: true,
      sites: { select: { site_name: true } },
      billing: { select: { subscription_status: true, stripe_customer_id: true, first_paid_at: true } },
    },
  });
  if (!g) return null;
  const via = await cameVia(db, groupId);
  const heard = via.heardAbout
    ? `${via.heardAbout.label}${via.heardAbout.other ? ` — “${via.heardAbout.other}”` : ''}`
    : 'not recorded';
  const campaign = via.utm.source || via.utm.medium || via.utm.campaign
    ? [via.utm.source, via.utm.medium, via.utm.campaign].map((x) => x ?? '—').join(' / ')
    : 'not recorded';
  return {
    ref: g.ref,
    garage: g.trading_name || g.group_name,
    legalName: g.group_name,
    contactEmail: g.billing_email,
    contactPhone: g.phone ?? 'not given',
    country: g.country_code ?? 'not chosen yet',
    // SITES ARE OFTEN ZERO HERE, and that is the truth rather than a gap: the site is named in the
    // onboarding step, which happens after registration. Named, so the alert does not read as a
    // garage with no premises.
    sites: g.sites.length ? g.sites.map((s: any) => s.site_name).join(', ') : 'none yet (named during setup)',
    siteCount: g.sites.length,
    plan: await planShape(db, groupId),
    tenantStatus: g.status,
    subscriptionStatus: g.billing?.subscription_status ?? 'no subscription yet',
    registered: when(g.created_at),
    trialEnds: g.trial_ends_at ? when(g.trial_ends_at) : 'not set',
    introducedBy: referrerSentence(via.referrer),
    heardAbout: heard,
    campaign,
  };
}

/** A FIRST PAYMENT. The garage, the plan, the amount, and who introduced them. */
export async function firstPaymentPayload(
  db: Db, groupId: string, paid: { amountPennies: number; currency?: string | null; invoiceRef?: string | null; paidAt?: Date | null },
): Promise<TemplateData | null> {
  const base = await garagePayload(db, groupId);
  if (!base) return null;
  return {
    ...base,
    amount: formatMoney(paid.amountPennies, { currency: (paid.currency ?? 'GBP').toUpperCase() }),
    invoiceRef: paid.invoiceRef ?? 'not recorded',
    paidAt: when(paid.paidAt ?? new Date()),
  };
}

// ── THE FOUR CALLS THE REST OF THE APP MAKES ───────────────────────────────────────────────────
//
// One function per alert, each building its own payload and each swallowing its own errors. The
// call sites are a signup, a webhook and a cron: none of them may fail because an email to us did.
// A missing subject is reported, not thrown — a garage deleted between the trigger and the send is
// an ordinary race, and the alert is simply not worth sending any more.

/**
 * ONE PATH FOR ALL FOUR, so the cap, the catch and the missing-subject answer are written once.
 * `timeoutMs` defaults to the inline cap: the dangerous call site is the one inside a request, so
 * that is the one the default protects. The sweep passes null for no cap.
 */
async function deliver(
  db: Db,
  kind: OperatorAlertKind,
  subjectId: string,
  build: () => Promise<TemplateData | null>,
  timeoutMs: number | null | undefined,
): Promise<AlertOutcome> {
  const ms = timeoutMs === undefined ? INLINE_TIMEOUT_MS : timeoutMs;
  try {
    const work = (async (): Promise<AlertOutcome> => {
      const data = await build();
      if (!data) return { kind, subjectId, results: [], error: 'the subject no longer exists' };
      return sendOperatorAlert(db, { kind, subjectId, data });
    })();
    const raced = await withCap(work, ms);
    if (raced.timedOut) {
      // SAID, NOT SWALLOWED. The caller logs it, the sweep finishes it, and the row — if the send
      // completes — is written by the send itself.
      return { kind, subjectId, results: [], timedOut: true };
    }
    return raced.value;
  } catch (e) {
    console.error(`[operator-alerts] ${kind} threw for`, subjectId, e);
    return { kind, subjectId, results: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** A person joined the affiliate programme and has just proved their handset. */
export async function alertAffiliateJoined(db: Db, repId: string, opts?: { timeoutMs?: number | null }): Promise<AlertOutcome> {
  return deliver(db, 'affiliate_joined', repId, () => affiliatePayload(db, repId), opts?.timeoutMs);
}

/** A garage signed up. Fired from the signup endpoint, and again by the sweep if that never ran. */
export async function alertGarageRegistered(db: Db, groupId: string, opts?: { timeoutMs?: number | null }): Promise<AlertOutcome> {
  return deliver(db, 'garage_registered', groupId, () => garagePayload(db, groupId), opts?.timeoutMs);
}

/** An hour has passed and there is no payment method. The one that earns a phone call. */
export async function alertGarageNoCheckout(db: Db, groupId: string, opts?: { timeoutMs?: number | null }): Promise<AlertOutcome> {
  return deliver(db, 'garage_no_checkout', groupId, () => garagePayload(db, groupId), opts?.timeoutMs);
}

/**
 * A TRIAL BECAME A PAYING CUSTOMER. Called where first_paid_at is STAMPED (recordFirstPayment),
 * which returns 'recorded' exactly once for exactly this event — so the caller's own idempotency
 * and this alert's agree by construction rather than by two separate rules.
 */
export async function alertFirstPayment(
  db: Db,
  groupId: string,
  paid: { amountPennies: number; currency?: string | null; invoiceRef?: string | null; paidAt?: Date | null },
  opts?: { timeoutMs?: number | null },
): Promise<AlertOutcome> {
  return deliver(db, 'first_payment', groupId, () => firstPaymentPayload(db, groupId, paid), opts?.timeoutMs);
}

// ── THE SWEEP ──────────────────────────────────────────────────────────────────────────────────

/**
 * NOT ONE OF OURS — and `is_internal: false` is the wrong way to write it.
 *
 * Group.is_internal is NULLABLE, and NULL means nobody has said. Postgres puts NULL outside
 * `= false`, so `{ is_internal: false }` matches only the rows somebody explicitly set to false —
 * which here would have been a sweep that skipped almost every real customer and alerted on
 * nothing. (It has happened once already: a query shaped that way matched none of seven tenants.)
 * NULL is a customer, so NULL must be IN.
 */
const NOT_OURS = { OR: [{ is_internal: null }, { is_internal: false }] } as const;

/**
 * REGISTERED, AND NEVER REACHED CHECKOUT. Derived, not tracked: a garage that has no Stripe
 * customer an hour after registering has not been through checkout, and nothing needed a column
 * to say so.
 *
 * BOUNDED AT BOTH ENDS. Older than the window is history, not an alert — and without the lower
 * bound the first run of this sweep would have emailed one alert for every garage that ever
 * registered and did not subscribe. Demo and internal tenants are excluded: they are ours.
 */
export async function pendingNoCheckout(db: Db, now: Date = new Date()): Promise<Array<{ id: string }>> {
  const by = new Date(now.getTime() - NO_CHECKOUT_AFTER_MINUTES * 60_000);
  const from = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 86_400_000);
  return (db as any).group.findMany({
    where: {
      created_at: { lt: by, gte: from },
      is_demo: false,
      AND: [
        NOT_OURS,
        // NO STRIPE CUSTOMER = never reached checkout. Two shapes mean the same thing: no
        // GroupBilling row at all, and a row that exists with no customer on it.
        { OR: [{ billing: { is: null } }, { billing: { stripe_customer_id: null } }] },
      ],
    },
    select: { id: true },
    orderBy: { created_at: 'asc' },
  });
}

/** Recently registered garages, for the catch-up half of the sweep. Same window, same exclusions. */
export async function recentlyRegistered(db: Db, now: Date = new Date()): Promise<Array<{ id: string }>> {
  const from = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 86_400_000);
  return (db as any).group.findMany({
    where: { created_at: { gte: from }, is_demo: false, AND: [NOT_OURS] },
    select: { id: true }, orderBy: { created_at: 'asc' },
  });
}

/** Affiliates who joined inside the window, for the catch-up half of the sweep. */
export async function recentlyJoinedAffiliates(db: Db, now: Date = new Date()): Promise<Array<{ id: string }>> {
  const from = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 86_400_000);
  return (db as any).rep.findMany({
    where: { party_type: 'affiliate', created_at: { gte: from } },
    select: { id: true }, orderBy: { created_at: 'asc' },
  });
}

// ── THE HOURLY SWEEP ───────────────────────────────────────────────────────────────────────────

export type SweepResult = {
  at: string;
  recipients: number;
  attempted: Record<string, number>;
  sent: number;
  failed: number;
  skipped: number;
  alreadySent: number;
  errors: string[];
};

/**
 * THE HOURLY SWEEP. One alert is inherently time-based — "registered an hour ago and never reached
 * checkout" cannot be fired by the registration itself — and the same pass catches up anything the
 * inline triggers missed, which is what makes "never blocks the signup" safe: the inline send is a
 * nudge, and this is the thing that is allowed to be late.
 *
 * EVERY SEND IS IDEMPOTENT, so re-walking the window is free in effect: a settled alert is counted
 * as `alreadySent` and nothing is sent. That is why the sweep can afford to look at every garage
 * registered in the last SWEEP_WINDOW_DAYS rather than tracking which ones it has seen.
 *
 * THE WINDOW HAS A LOWER BOUND, and that bound is the difference between a useful sweep and an
 * accident: without it the FIRST run would have emailed one alert for every garage that ever
 * registered without subscribing.
 *
 * `first_payment` IS NOT SWEPT, deliberately. Its alert names the amount, and the amount lives on
 * the Stripe invoice the webhook was handed — nothing local records it, so a catch-up would have
 * to print "not recorded" where the figure belongs. A webhook that never arrived is re-delivered by
 * Stripe (and the alert is idempotent); one whose send failed is visible on the Engine Room screen
 * with its error. An alert that lies about the money would be worse than a late one.
 */
export async function runOperatorAlertSweep(db: Db, now: Date = new Date()): Promise<SweepResult> {
  const settings = await (db as any).programmeSettings.findUnique({ where: { id: 'singleton' }, select: { alert_emails: true } }).catch(() => null);
  const recipients = resolveRecipients(settings);
  const result: SweepResult = {
    at: now.toISOString(), recipients: recipients.length,
    attempted: { affiliate_joined: 0, garage_registered: 0, garage_no_checkout: 0 },
    sent: 0, failed: 0, skipped: 0, alreadySent: 0, errors: [],
  };

  const tally = (o: AlertOutcome) => {
    result.attempted[o.kind] = (result.attempted[o.kind] ?? 0) + 1;
    if (o.timedOut) result.errors.push(`${o.kind} ${o.subjectId}: the send did not answer in time`);
    if (o.error) result.errors.push(`${o.kind} ${o.subjectId}: ${o.error}`);
    for (const r of o.results) {
      if (r.action === 'sent') result.sent++;
      else if (r.action === 'failed') { result.failed++; result.errors.push(`${o.kind} ${o.subjectId} → ${r.recipient}: ${r.detail ?? 'failed'}`); }
      else if (r.action === 'skipped') result.skipped++;
      else result.alreadySent++;
    }
  };

  // NO CAP HERE, deliberately: nothing is waiting on this cron, and a cap would convert a slow
  // provider into a silently unfinished sweep instead of a slow one.
  const uncapped = { timeoutMs: null };
  for (const r of await recentlyJoinedAffiliates(db, now)) tally(await alertAffiliateJoined(db, r.id, uncapped));
  for (const g of await recentlyRegistered(db, now)) tally(await alertGarageRegistered(db, g.id, uncapped));
  for (const g of await pendingNoCheckout(db, now)) tally(await alertGarageNoCheckout(db, g.id, uncapped));
  return result;
}

// ── WHAT THE SCREEN SHOWS ──────────────────────────────────────────────────────────────────────

export type AlertRow = {
  id: string;
  kind: OperatorAlertKind | null;
  label: string;
  subjectId: string | null;
  recipient: string;
  status: string;
  error: string | null;
  at: string;
};

const KIND_BY_TEMPLATE = new Map<string, OperatorAlertKind>(
  OPERATOR_ALERT_KINDS.map((k) => [OPERATOR_ALERTS[k].template, k]),
);

/**
 * The last alerts, newest first, for /superadmin/billing. Reads NotificationLog — the single record
 * of what was sent — rather than a second table that could disagree with it.
 */
export async function recentAlerts(db: Db, limit = 20): Promise<AlertRow[]> {
  const rows = await (db as any).notificationLog.findMany({
    where: { template: { in: ALERT_TEMPLATES } },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: { id: true, template: true, subject_id: true, recipient: true, status: true, error: true, created_at: true },
  });
  return rows.map((r: any) => {
    const kind = KIND_BY_TEMPLATE.get(r.template) ?? null;
    return {
      id: r.id, kind, label: kind ? OPERATOR_ALERTS[kind].label : r.template,
      subjectId: r.subject_id ?? null, recipient: r.recipient,
      status: r.status, error: r.error ?? null,
      at: (r.created_at as Date).toISOString(),
    };
  });
}

/**
 * HOW MANY ALERTS ARE CURRENTLY UNDELIVERED — a (template, subject, recipient) whose only rows are
 * failures. Counted rather than inferred from the list above, which is capped at `limit` and would
 * under-report the moment there were more than a screenful.
 */
export async function failedAlertCount(db: Db): Promise<number> {
  const rows = await (db as any).notificationLog.findMany({
    where: { template: { in: ALERT_TEMPLATES } },
    select: { template: true, subject_id: true, recipient: true, status: true },
  });
  const byKey = new Map<string, { any: boolean; settled: boolean }>();
  for (const r of rows) {
    const key = `${r.template}|${r.subject_id ?? ''}|${r.recipient}`;
    const cur = byKey.get(key) ?? { any: false, settled: false };
    cur.any = true;
    if (r.status !== 'failed') cur.settled = true;
    byKey.set(key, cur);
  }
  return [...byKey.values()].filter((v) => v.any && !v.settled).length;
}
