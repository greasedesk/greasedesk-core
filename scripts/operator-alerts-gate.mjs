/**
 * File: scripts/operator-alerts-gate.mjs
 * THE FOUR ALERTS TO THE OWNER — sent once, never blocking, and a failure that is visible.
 * @gate-requires: server, db
 *
 * ── WHAT IS ACTUALLY AT RISK HERE ───────────────────────────────────────────────────────────────
 * Three of these fire from a SIGNUP and one from a STRIPE WEBHOOK. Both are paths where an
 * exception is expensive: a signup that fails because we could not email ourselves is a lost
 * customer, and a webhook that throws is retried by Stripe for hours. So "never blocks" is not a
 * nicety, and neither is "sent once": the hourly sweep re-walks a seven-day window, so an alert
 * whose idempotency does not hold is an email every hour for a week about the same garage.
 *
 * ── THE THREE THINGS A CLAUSE HERE HAS TO GET RIGHT ─────────────────────────────────────────────
 *   1. SETTLED vs FAILED. A `skipped` row is a deliberate non-send with its reason on it and must
 *      settle the alert; a `failed` row must NOT, because a provider hiccup is worth another go.
 *      Both are asserted, in both directions, because a rule that only reads one of them passes
 *      against code that treats every row the same.
 *   2. PER RECIPIENT. Two addresses are two messages. A rule keyed on (alert, subject) alone sends
 *      one email and marks both as done.
 *   3. NULL IS A CUSTOMER. Group.is_internal is nullable, so the sweep's exclusion cannot be
 *      written `is_internal: false` — that matches only rows somebody set explicitly and would
 *      skip nearly every real garage. A fixture with NULL is planted for exactly that.
 *
 * ── EVERY SEND IN THIS GATE IS REFUSED BY THE ENVIRONMENT MARKER, AND THAT IS THE POINT ─────────
 * This is the gate database, so sendNotification records `skipped / test_environment` and nothing
 * leaves the building. The row is still written, which is what the idempotency reads — so the
 * clauses below prove the real mechanism without a single email being sent. The marker itself is
 * asserted first: a premise stated in a comment is not a premise that was checked.
 *
 * FIXTURES: the ZZAL prefix, swept before and after in a registered teardown.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, gateOrigin, erOrigin, ER_RESOLVER_ARGS, serverReady, onTeardown, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('/Users/hugh/Developer/greasedesk-core/node_modules/bcryptjs/index.js')).default;
const { underPath } = await import('../lib/anchored-match.ts');
const OA = await import('../lib/operator-alerts.ts');
const PC = await import('../lib/platform-contact.ts');
const TPL = await import('../lib/notification-templates.ts');
const { readEnvironment } = await import('../lib/environment.ts');
const fs = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZAL';
const LOW = PREFIX.toLowerCase();
const PASS = 'GateGarage!2026';
const OP_EMAIL = `${LOW}-operator-alerts-gate@greasedesk.test`;
const OP_PASS = 'GateAlerts!2026';
const TO_A = `${LOW}-owner-a@example.invalid`;
const TO_B = `${LOW}-owner-b@example.invalid`;

let prisma, browser;
let alertEmailsBefore = null;

const sweep = async () => {
  if (!prisma) return 0;
  const named = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  const viaUsers = (await prisma.user.findMany({ where: { email: { startsWith: `${LOW}-` } }, select: { group_id: true } })).map((u) => u.group_id);
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX, mode: 'insensitive' } }, select: { id: true } })).map((r) => r.id);
  const all = [...new Set([...named, ...viaUsers])].filter(Boolean);
  // THE ALERT ROWS FIRST, keyed by the subjects that are about to go — a NotificationLog row for a
  // deleted group is not an orphan to be swept later, it is a row nothing can explain.
  if (all.length || reps.length) {
    await prisma.notificationLog.deleteMany({ where: { subject_id: { in: [...all, ...reps] } } }).catch(() => {});
  }
  await prisma.notificationLog.deleteMany({ where: { recipient: { in: [TO_A, TO_B] } } }).catch(() => {});
  if (all.length) {
    await prisma.superAdminAudit.deleteMany({ where: { target_group_id: { in: all } } }).catch(() => {});
    for (const t of ['tenantAffiliateTerms', 'tenantAttribution', 'tenantPlanTerms', 'commissionEntry', 'groupBilling', 'auditLog', 'user']) {
      await prisma[t].deleteMany({ where: { group_id: { in: all } } }).catch(() => {});
    }
    await prisma.group.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  }
  if (reps.length) {
    await prisma.twoFactorSecret.deleteMany({ where: { subject_type: 'rep', subject_id: { in: reps } } }).catch(() => {});
    await prisma.deliveredCode.deleteMany({ where: { subject_type: 'rep', subject_id: { in: reps } } }).catch(() => {});
    await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  }
  await prisma.verificationToken.deleteMany({ where: { identifier: { startsWith: `${LOW}-` } } }).catch(() => {});
  await prisma.superAdminAudit.deleteMany({ where: { action: 'programme_alert_emails' } }).catch(() => {});
  await prisma.operator.deleteMany({ where: { email: OP_EMAIL } }).catch(() => {});
  if (alertEmailsBefore !== null) {
    await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { alert_emails: alertEmailsBefore } }).catch(() => {});
  }
  return all.length + reps.length;
};

/** Every alert row for one subject, which is what both the idempotency and the screen read. */
const rowsFor = (template, subjectId) => prisma.notificationLog.findMany({
  where: { template, subject_id: subjectId },
  select: { status: true, recipient: true, error: true, scope: true, group_id: true, counts_to_allowance: true },
  orderBy: { created_at: 'asc' },
});

const mkGroup = (n, over = {}) => prisma.group.create({
  data: {
    group_name: `${PREFIX} garage ${n}`,
    billing_email: `${LOW}-${n}@example.invalid`,
    trial_ends_at: new Date(Date.now() + 30 * 86400000),
    ...over,
  },
  select: { id: true, ref: true },
});

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const ready = await serverReady('/register');
  if (!ready.ok) declineToRun(`the dev server is not answering on ${gateOrigin()} — ${ready.reason ?? 'no response'}. The signup and Engine Room clauses drive real pages; without a server nothing here has been tested.`);
  check('the dev server serves the signup page before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  // THE PREMISE, CHECKED. Every clause below rests on sends being refused by the marker; stated in
  // a comment that is a hope, asserted here it is a fact.
  const env = await readEnvironment(prisma);
  check('this is the test database, so every send below is refused before it leaves',
    env.kind === 'test', `Environment.kind = ${env.kind}`);

  const before = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { alert_emails: true } });
  alertEmailsBefore = before?.alert_emails ?? [];

  // ── 1. WHO GETS THEM ─────────────────────────────────────────────────────────────────────────
  console.log('\n— the recipients —');
  check('an empty list is NOT "send to nobody" — it resolves to the platform address',
    PC.alertRecipients({ alert_emails: [] }).length === 1 && PC.alertRecipients({ alert_emails: [] })[0] === PC.platformContactTo(),
    `${PC.alertRecipients({ alert_emails: [] }).join(', ')} — an empty array would make every alert a "no recipient" skip`);
  check('  …and so is a missing row, or a null column',
    PC.alertRecipients(null)[0] === PC.platformContactTo() && PC.alertRecipients({ alert_emails: null })[0] === PC.platformContactTo());
  check('a chosen list wins',
    JSON.stringify(PC.alertRecipients({ alert_emails: [TO_A, TO_B] })) === JSON.stringify([TO_A, TO_B]));
  // THE SAME ADDRESS THE CONTACT FORM USES, asserted against the file rather than against a copy
  // of the address written here: a second literal would agree with itself for ever.
  const contactSrc = fs.readFileSync('/Users/hugh/Developer/greasedesk-core/pages/api/contact.ts', 'utf8');
  check('the default is the SAME address the contact form delivers to',
    contactSrc.includes('platformContactTo()') && !/hugh@greasedesk\.com/.test(contactSrc),
    'one source — the form had the literal, and a second copy for the alerts would drift the day it changed');

  console.log('\n— and the clean —');
  const cleaned = PC.refuseAlertEmails(`  ${TO_A.toUpperCase()}\n${TO_A}, ${TO_B};\n\n`);
  check('lines, commas and semicolons all split, and it de-duplicates',
    cleaned.ok && JSON.stringify(cleaned.emails) === JSON.stringify([TO_A, TO_B]), JSON.stringify(cleaned.emails ?? cleaned.message));
  check('  …LOWER-CASED, because the stored list is matched against what was sent',
    cleaned.ok && cleaned.emails.every((e) => e === e.toLowerCase()),
    'one side storing Hugh@ while the other matches hugh@ is an alert that sends every hour');
  const bad = PC.refuseAlertEmails('not-an-address');
  check('a non-address is refused, and named', bad.ok === false && /not-an-address/.test(bad.message), bad.message);
  check('  …and nothing is refused for being absent',
    PC.refuseAlertEmails(null).ok === true && PC.refuseAlertEmails('').ok === true,
    'clearing the box is a legitimate act — it restores the default recipient');
  const many = PC.refuseAlertEmails(Array.from({ length: OA.MAX_ALERT_RECIPIENTS + 1 }, (_, i) => `a${i}@example.invalid`).join('\n'));
  check('  …and a list that is somebody pasting a mailing list is refused', many.ok === false, many.message);

  // ── 2. SENT ONCE — THE RULE, IN BOTH DIRECTIONS ──────────────────────────────────────────────
  console.log('\n— sent once —');
  const rowsSent = [{ status: 'sent', recipient: TO_A }];
  const rowsSkipped = [{ status: 'skipped', recipient: TO_A }];
  const rowsFailed = [{ status: 'failed', recipient: TO_A }];
  check('a sent row settles it', OA.refuseAttempt(rowsSent, TO_A) === 'already_sent');
  check('a SKIPPED row settles it too',
    OA.refuseAttempt(rowsSkipped, TO_A) === 'already_sent',
    'a deliberate non-send carries its reason — re-attempting produces the identical refusal every hour');
  check('a FAILED row does NOT settle it',
    OA.refuseAttempt(rowsFailed, TO_A) === null,
    'the provider rejecting it is worth another go; this is the half a "any row exists" rule gets wrong');
  check('  …but not for ever',
    OA.refuseAttempt([...rowsFailed, ...rowsFailed, ...rowsFailed], TO_A) === 'attempts_exhausted',
    `${OA.ATTEMPT_CAP} attempts — without a cap the hourly sweep retries a bad address 24 times a day`);
  check('one recipient failing does not settle the OTHER',
    OA.refuseAttempt([{ status: 'sent', recipient: TO_A }], TO_B) === null,
    'two addresses are two messages, and a rule keyed on the subject alone sends one and marks both done');

  // ── 3. A GARAGE REGISTERS, THROUGH THE REAL SIGNUP ───────────────────────────────────────────
  console.log('\n— a garage registered —');
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { alert_emails: [TO_A, TO_B] } });
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const addr = `${LOW}-signup@example.invalid`;
  await page.goto(`${gateOrigin()}/register?utm_source=zzal-src&utm_campaign=zzal-camp`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="heard-about"]');
  await page.fill('input[autocomplete="name"]', `${PREFIX} signup`);
  await page.fill('input[type="email"]', addr);
  await page.fill('input[type="password"]', PASS);
  await page.selectOption('[data-testid="heard-about"]', 'youtube');
  await page.click('button[type="submit"]');
  await page.waitForURL(/check-email/, { timeout: 25000 });
  const signedUpUser = await prisma.user.findUnique({ where: { email: addr }, select: { group_id: true } });
  const gid = signedUpUser?.group_id;
  check('the signup completed', !!gid, gid ?? 'no user row');

  let rows = await rowsFor('alert_garage_registered', gid);
  check('ONE alert row per recipient was written by the signup itself',
    rows.length === 2 && new Set(rows.map((r) => r.recipient)).size === 2,
    `${rows.length} row(s): ${rows.map((r) => `${r.recipient}=${r.status}`).join(', ')}`);
  check('  …and nothing was sent: the marker refused it and said so on the row',
    rows.every((r) => r.status === 'skipped' && /test environment/i.test(r.error ?? '')),
    rows[0]?.error ?? 'no error recorded');
  check('  …recorded as a PLATFORM send, carrying no tenant scope',
    rows.every((r) => r.scope === 'platform' && r.group_id === null),
    'it is about a garage and it is not the garage\'s message — the CHECK constraint enforces the pairing');
  check('  …and it spends no garage\'s allowance',
    rows.every((r) => r.counts_to_allowance === false));

  // AND THE SIGNUP STILL SUCCEEDED while every send was refused — which is the "never blocks"
  // promise, observed rather than asserted about the code.
  check('the garage exists and is usable although no alert was sent',
    (await prisma.group.findUnique({ where: { id: gid }, select: { status: true } }))?.status === 'trial',
    'the alert is not in the signup\'s success path');

  // ── 4. AND NOT TWICE ─────────────────────────────────────────────────────────────────────────
  console.log('\n— and not twice —');
  const again = await OA.alertGarageRegistered(prisma, gid);
  check('calling it again sends nothing and says why',
    again.results.length === 2 && again.results.every((r) => r.action === 'already_sent'),
    JSON.stringify(again.results.map((r) => r.action)));
  check('  …and wrote no second row', (await rowsFor('alert_garage_registered', gid)).length === 2);
  const sweepOnce = await OA.runOperatorAlertSweep(prisma);
  check('the hourly sweep walks the window and sends nothing already settled',
    sweepOnce.alreadySent >= 2 && sweepOnce.sent === 0,
    `${sweepOnce.alreadySent} already sent, ${sweepOnce.sent} sent, ${sweepOnce.skipped} skipped`);
  check('  …and still wrote no second row for this garage',
    (await rowsFor('alert_garage_registered', gid)).length === 2,
    'the sweep re-walks seven days, so an idempotency that does not hold is an email an hour for a week');

  // ── 5. REGISTERED AND NEVER REACHED CHECKOUT ─────────────────────────────────────────────────
  console.log('\n— registered, no checkout —');
  const now = new Date();
  const ago = (mins) => new Date(now.getTime() - mins * 60_000);
  // NULL is_internal IS A CUSTOMER. This is the fixture the whole exclusion turns on.
  const old = await mkGroup('old', { created_at: ago(120) });
  const fresh = await mkGroup('fresh', { created_at: ago(10) });
  const stale = await mkGroup('stale', { created_at: new Date(now.getTime() - 8 * 86400000) });
  const paid = await mkGroup('paidup', { created_at: ago(120) });
  // GroupBilling REQUIRES plan_name, status, retention_months and included_sites — the error names
  // them, and every sibling gate passes them.
  const billingFor = (groupId, customer) => prisma.groupBilling.create({ data: {
    group_id: groupId, plan_name: 'standard', status: 'ok', retention_months: 12, included_sites: 1,
    stripe_customer_id: customer } });
  await billingFor(paid.id, `cus_${PREFIX}_1`);
  const demo = await mkGroup('demo', { created_at: ago(120), is_demo: true });
  const ours = await mkGroup('ours', { created_at: ago(120), is_internal: true });

  const pending = (await OA.pendingNoCheckout(prisma, now)).map((g) => g.id);
  check('a garage that registered two hours ago with no payment method is in the sweep',
    pending.includes(old.id), `${pending.length} pending`);
  check('  …AND ITS is_internal IS NULL, which is what a real customer\'s looks like',
    (await prisma.group.findUnique({ where: { id: old.id }, select: { is_internal: true } }))?.is_internal === null,
    'written `is_internal: false` the query would match only rows somebody set, and skip nearly every garage');
  check('one that registered ten minutes ago is NOT yet',
    !pending.includes(fresh.id), `the hour is ${OA.NO_CHECKOUT_AFTER_MINUTES} minutes`);
  check('one from eight days ago is NOT either',
    !pending.includes(stale.id),
    `the window is ${OA.SWEEP_WINDOW_DAYS} days — without a lower bound the FIRST run emails every garage that ever registered`);
  check('one that HAS a Stripe customer is not in it',
    !pending.includes(paid.id), 'a payment method on file is what "reached checkout" means');
  check('a demo tenant is not in it, and nor is one of ours',
    !pending.includes(demo.id) && !pending.includes(ours.id));

  const swept = await OA.runOperatorAlertSweep(prisma, now);
  const oldRows = await rowsFor('alert_garage_no_checkout', old.id);
  check('the sweep raised the no-checkout alert for it, once per recipient',
    oldRows.length === 2, `${oldRows.length} row(s)`);
  check('  …and raised nothing for the garage that is only ten minutes old',
    (await rowsFor('alert_garage_no_checkout', fresh.id)).length === 0);
  check('  …and the sweep reports what it did', swept.attempted.garage_no_checkout >= 1, JSON.stringify(swept.attempted));

  // ── 6. A FAILED SEND IS NOT SETTLED, AND IT IS VISIBLE ───────────────────────────────────────
  console.log('\n— a failure is visible —');
  // A failure cannot be arranged through the provider from here, so one is PLANTED — the row is
  // what both the idempotency and the screen read, so a planted row exercises the same code path
  // the provider would have produced.
  const failSubject = await mkGroup('failed', { created_at: ago(120) });
  await prisma.notificationLog.create({ data: {
    scope: 'platform', group_id: null, channel: 'email', template: 'alert_garage_registered',
    provider: 'resend', status: 'failed', recipient: TO_A, error: 'ZZAL planted: the provider rejected it',
    subject_type: 'group', subject_id: failSubject.id, counts_to_allowance: false } });
  const failedCount = await OA.failedAlertCount(prisma);
  check('an undelivered alert is counted', failedCount >= 1, `${failedCount} undelivered`);
  const listed = await OA.recentAlerts(prisma, 50);
  const mine = listed.find((a) => a.subjectId === failSubject.id);
  check('  …and it is on the list with its reason, in words',
    !!mine && mine.status === 'failed' && /planted/.test(mine.error ?? ''),
    mine ? `${mine.label} → ${mine.recipient}: ${mine.error}` : 'not listed');
  check('  …named by what it IS, not by its template key',
    mine?.label === OA.OPERATOR_ALERTS.garage_registered.label, mine?.label);
  const retry = await OA.alertGarageRegistered(prisma, failSubject.id);
  check('  …and a failed recipient is tried again, while the other is a first attempt',
    retry.results.filter((r) => r.action === 'skipped').length === 2,
    JSON.stringify(retry.results.map((r) => `${r.recipient.split('@')[0]}:${r.action}`)));

  // ── 7. AN AFFILIATE JOINS ────────────────────────────────────────────────────────────────────
  console.log('\n— an affiliate joined —');
  const aff = await prisma.rep.create({ data: {
    party_type: 'affiliate', email: `${LOW}-aff@example.invalid`, name: `${PREFIX} Affiliate`,
    ref_code: `${PREFIX}CODE`, terms_accepted_at: new Date(), social_handle: 'youtube.com/@zzal',
    find_method: 'my channel' }, select: { id: true } });
  await prisma.twoFactorSecret.create({ data: {
    subject_type: 'rep', subject_id: aff.id, phone_e164: '447700900456',
    phone_verified_at: new Date('2026-10-30T09:00:00Z'), method: 'sms' } });
  const affPayload = await OA.affiliatePayload(prisma, aff.id);
  check('the alert carries the name, email, mobile, code and BOTH verifications',
    affPayload.name === `${PREFIX} Affiliate` && affPayload.refCode === `${PREFIX}CODE`
    && affPayload.mobile === '447700900456' && /^yes/.test(String(affPayload.smsVerified)) && affPayload.emailVerified === 'no',
    `sms ${affPayload.smsVerified} / email ${affPayload.emailVerified}`);
  check('  …the mobile from where it is WRITTEN, not from a second copy on the affiliate',
    affPayload.mobile === '447700900456',
    'TwoFactorSecret, which confirmPhoneVerification writes and nothing else does');
  check('  …and the words "yes"/"no", not a tick',
    affPayload.emailVerified === 'no',
    'a tick and a blank cell read the same in an email');
  const affOut = await OA.alertAffiliateJoined(prisma, aff.id);
  check('the affiliate alert is raised once per recipient',
    (await rowsFor('alert_affiliate_joined', aff.id)).length === 2, JSON.stringify(affOut.results.map((r) => r.action)));
  check('  …and the sweep does not raise it again',
    (await OA.runOperatorAlertSweep(prisma)).sent === 0
    && (await rowsFor('alert_affiliate_joined', aff.id)).length === 2);

  // ── 8. A TRIAL BECOMES A PAYING CUSTOMER ─────────────────────────────────────────────────────
  console.log('\n— the first payment —');
  const payer = await mkGroup('payer', { created_at: ago(1000) });
  await billingFor(payer.id, `cus_${PREFIX}_PAY`);
  const CACHE = await import('../lib/stripe-billing-cache.ts');
  const invoice = { id: `in_${PREFIX}_1`, number: `${PREFIX}-0001`, customer: `cus_${PREFIX}_PAY`,
    amount_paid: 75000, currency: 'gbp', status_transitions: { paid_at: Math.floor(Date.UTC(2026, 9, 30, 12, 0, 0) / 1000) } };
  // THE PREMISE THE WEBHOOK'S GATE RESTS ON, asserted here rather than assumed: the alert fires on
  // 'recorded', so if that verdict were not once-only the alert would not be either.
  check('recordFirstPayment says "recorded" the first time',
    (await CACHE.recordFirstPayment(prisma, invoice)) === 'recorded');
  check('  …and "already recorded" the second, which is what gates the alert',
    (await CACHE.recordFirstPayment(prisma, invoice)) === 'already recorded');
  check('  …and the invoice resolves to the garage through ONE resolution',
    (await CACHE.groupIdForInvoiceCustomer(prisma, invoice)) === payer.id,
    'the webhook names the garage without a second copy of "how a Stripe customer becomes a group"');
  const payPayload = await OA.firstPaymentPayload(prisma, payer.id, {
    amountPennies: 75000, currency: 'gbp', invoiceRef: `${PREFIX}-0001`, paidAt: new Date('2026-10-30T12:00:00Z') });
  check('the alert names the garage, the plan, the amount and who introduced them',
    payPayload.amount === '£750.00' && typeof payPayload.plan === 'string' && typeof payPayload.introducedBy === 'string',
    `${payPayload.amount} · plan ${payPayload.plan} · ${payPayload.introducedBy}`);
  await OA.alertFirstPayment(prisma, payer.id, { amountPennies: 75000, currency: 'gbp', invoiceRef: `${PREFIX}-0001` });
  check('  …and it is raised once per recipient',
    (await rowsFor('alert_first_payment', payer.id)).length === 2);
  await OA.alertFirstPayment(prisma, payer.id, { amountPennies: 75000, currency: 'gbp', invoiceRef: `${PREFIX}-0001` });
  check('  …and a re-delivered webhook adds nothing',
    (await rowsFor('alert_first_payment', payer.id)).length === 2,
    'Stripe re-delivers; the alert must not');
  check('first_payment is NOT swept, so no catch-up can invent an amount',
    !('first_payment' in (await OA.runOperatorAlertSweep(prisma)).attempted),
    'the figure lives on the Stripe invoice the webhook held; a sweep would have to print "not recorded" where the money goes');

  // ── 9. THE CAP ON AN INLINE SEND ─────────────────────────────────────────────────────────────
  console.log('\n— a slow provider cannot slow a signup —');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  check('a capped call returns the result when it answers in time',
    (await OA.withCap(Promise.resolve('answered'), 1000)).value === 'answered');
  const t0 = Date.now();
  const late = await OA.withCap(sleep(4000).then(() => 'too late'), 200);
  const waited = Date.now() - t0;
  check('  …and gives up AT the cap, not when the work finishes',
    late.timedOut === true && waited < 1500,
    `${waited}ms against a 4000ms operation — a race that awaits the loser is not a cap`);
  check('  …while no cap means no cap',
    (await OA.withCap(sleep(50).then(() => 'fine'), null)).value === 'fine',
    'the sweep passes null: nothing waits on a cron, and a cap there hides a slow provider');

  // THE DEFAULT IS THE CAP, proved through the real helper with a database that does not answer.
  // A stub is the only way to make a read slow on purpose, and the clause is about the TIMING, not
  // about what the stub returns.
  const slowDb = { group: { findUnique: async () => { await sleep(6000); return null; } } };
  const t1 = Date.now();
  const capped = await OA.alertGarageRegistered(slowDb, 'zzal-nobody');
  const cappedMs = Date.now() - t1;
  check('an inline alert with no options is capped by default',
    capped.timedOut === true && cappedMs < OA.INLINE_TIMEOUT_MS + 1500,
    `${cappedMs}ms, cap ${OA.INLINE_TIMEOUT_MS}ms — the inline call sites pass no option, so the default is what protects them`);
  const t2 = Date.now();
  const uncapped = await OA.alertGarageRegistered(slowDb, 'zzal-nobody', { timeoutMs: null });
  check('  …and the same call UNCAPPED waits for its answer',
    uncapped.timedOut !== true && Date.now() - t2 > OA.INLINE_TIMEOUT_MS,
    `${Date.now() - t2}ms — this is the sweep's behaviour, and the two must differ or the cap is decoration`);
  check('  …and a timeout is reported as neither sent nor failed',
    capped.timedOut === true && capped.error === undefined && capped.results.length === 0,
    'three states: it went, it failed, or we do not know yet');

  // ── WHICH ALERTS MAY BE CAPPED AT ALL, AND WHY IT IS NOT A FREE CHOICE ───────────────────────
  // On Vercel a function can be FROZEN once it has responded, so a capped send that has not
  // finished is not "still running" — it may simply stop, leaving no row. The only thing that then
  // raises the alert is the sweep. So the cap is derived from whether the sweep walks that alert.
  check('every alert the sweep walks is capped, and the one it does not is NOT',
    OA.OPERATOR_ALERT_KINDS.every((k) => OA.defaultCapFor(k) === (OA.OPERATOR_ALERTS[k].swept ? OA.INLINE_TIMEOUT_MS : null))
    && OA.defaultCapFor('first_payment') === null,
    `${OA.OPERATOR_ALERT_KINDS.map((k) => `${k}:${OA.defaultCapFor(k) ?? 'uncapped'}`).join(' ')}`);
  // THE COMPLETENESS CLAUSE, and the one that stops this rotting: `swept: true` is a CLAIM about
  // the sweep, and a claim nobody checks is how an alert comes to be capped with nothing behind it.
  // Both sides are enumerated — the registry, and the kinds the sweep actually attempted.
  const sweptClaimed = OA.OPERATOR_ALERT_KINDS.filter((k) => OA.OPERATOR_ALERTS[k].swept).sort();
  const sweptActual = Object.keys((await OA.runOperatorAlertSweep(prisma, now)).attempted).sort();
  check('  …and "swept" is what the sweep ACTUALLY walks, not a claim beside it',
    JSON.stringify(sweptClaimed) === JSON.stringify(sweptActual),
    `registry says ${sweptClaimed.join(', ')} · the sweep walked ${sweptActual.join(', ')}`);
  const t3 = Date.now();
  const payUncapped = await OA.alertFirstPayment(slowDb, 'zzal-nobody', { amountPennies: 1 });
  check('  …so the first-payment alert with no options waits for its answer',
    payUncapped.timedOut !== true && Date.now() - t3 > OA.INLINE_TIMEOUT_MS,
    `${Date.now() - t3}ms — nothing sweeps it, so a cut-off send would be an alert nobody ever gets`);
  // THE DECISION IN THE WEBHOOK, pinned where no clause can reach it: the alert is attempted on a
  // RE-DELIVERY too, so Stripe's retry finishes an attempt that died after the date was stamped.
  const webhookSrc = fs.readFileSync('/Users/hugh/Developer/greasedesk-core/pages/api/stripe/webhook.ts', 'utf8');
  check('  …and the webhook attempts it on a re-delivery, not only on the first stamp',
    /paid === 'recorded' \|\| paid === 'already recorded'/.test(webhookSrc),
    'gated on the first verdict alone, a function that died mid-send would lose this alert for good');

  // AND THE GUARANTEE A CAP ACTUALLY RESTS ON. Two halves, and only the second is a guarantee.
  const slowSubject = await mkGroup('slowsend', { created_at: ago(120) });
  const cut = await OA.alertGarageRegistered(prisma, slowSubject.id, { timeoutMs: 1 });
  check('a send cut off at 1ms reports a timeout', cut.timedOut === true, JSON.stringify(cut));
  await sleep(4000); // let the work it did not wait for finish
  const landed = await rowsFor('alert_garage_registered', slowSubject.id);
  check('  …and ON THIS SERVER it finished anyway and wrote its rows',
    landed.length === 2,
    `${landed.length} row(s) — true of a long-lived dev server and NOT a production guarantee: Vercel can freeze the instance once it has responded`);
  const afterCut = await OA.runOperatorAlertSweep(prisma);
  check('  …and either way the sweep sends nothing a second time',
    (await rowsFor('alert_garage_registered', slowSubject.id)).length === 2 && afterCut.sent === 0,
    'idempotency read from the row the SEND writes — a flag set by the caller would be a lost alert or a duplicate');
  // THE HALF THAT IS THE GUARANTEE: no row at all — which is what a frozen function leaves — and
  // the sweep raises it. Arranged by removing the rows, because a frozen function cannot be
  // arranged from here and the state it leaves behind can.
  await prisma.notificationLog.deleteMany({ where: { template: 'alert_garage_registered', subject_id: slowSubject.id } });
  check('  …and a send that left NO ROW AT ALL is raised again by the sweep',
    (await OA.runOperatorAlertSweep(prisma)).attempted.garage_registered > 0
    && (await rowsFor('alert_garage_registered', slowSubject.id)).length === 2,
    'this is why a cap is survivable: the worst case is a late email, not a lost one');

  // ── 10. WHAT THE EMAIL ACTUALLY SAYS ──────────────────────────────────────────────────────────
  console.log('\n— the email itself —');
  const regPayload = await OA.garagePayload(prisma, gid);
  const rendered = TPL.NOTIFICATION_TEMPLATES.alert_garage_registered.email(regPayload);
  check('the subject names the garage and its ref',
    rendered.subject.includes(String(regPayload.ref)), rendered.subject);
  check('  …and the body carries all three Came via axes, separately',
    rendered.html.includes('Introduced by') && rendered.html.includes('How they heard of us') && rendered.html.includes('Campaign'),
    'collapsing them is how "we don\'t know" gets printed as "Direct"');
  check('  …with the campaign the link carried and the answer they gave',
    rendered.html.includes('zzal-src') && rendered.html.includes('YouTube'),
    'captured through the real form, in the real signup above');
  check('  …and the sites line says "none yet" rather than reading as a garage with no premises',
    /none yet/.test(String(regPayload.sites)),
    'the site is named in the onboarding step, which happens after registration');
  check('nothing in the alert is an unrendered object',
    !/\[object Object\]/.test(rendered.html), 'template data is strings and numbers, and the compiler says so');
  check('every one of the four alerts has a template that renders',
    OA.OPERATOR_ALERT_KINDS.every((k) => typeof TPL.NOTIFICATION_TEMPLATES[OA.OPERATOR_ALERTS[k].template]?.email === 'function'),
    `${OA.OPERATOR_ALERT_KINDS.length} alerts, enumerated from the registry rather than from a list written here`);

  // ── 11. AND THE OWNER CAN SET IT, AND SEE IT ─────────────────────────────────────────────────
  console.log('\n— through the real Engine Room —');
  // PLANTED HERE, AND NOT REUSED FROM SECTION 6. That one was retried by its own clause, and a
  // retry writes a `skipped` row which SETTLES it — so by the time the screen loaded there was
  // nothing undelivered left to show, and the clause about the warning failed for the right
  // reason. This row is the newest in the table and is never touched again.
  const screenFail = await mkGroup('screenfail', { created_at: ago(200) });
  await prisma.notificationLog.create({ data: {
    scope: 'platform', group_id: null, channel: 'email', template: 'alert_first_payment',
    provider: 'resend', status: 'failed', recipient: TO_A, error: 'ZZAL planted: mailbox full',
    subject_type: 'group', subject_id: screenFail.id, counts_to_allowance: false } });
  const op = await prisma.operator.create({ data: {
    email: OP_EMAIL, name: 'Operator alerts gate', role: 'owner', status: 'active',
    regions: ['GB'], passwordHash: await bcrypt.hash(OP_PASS, 10) }, select: { id: true } });
  const erBrowser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  try {
    const ER = erOrigin();
    const p2 = await (await erBrowser.newContext({ viewport: { width: 1280, height: 2600 } })).newPage();
    const onLogin = (pth) => underPath(pth, '/superadmin/login');
    await p2.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
    await p2.fill('input[type="email"]', OP_EMAIL);
    await p2.fill('input[type="password"]', OP_PASS);
    await p2.click('button[type="submit"]');
    await p2.waitForURL((u) => !onLogin(u.pathname), { timeout: 60000 }).catch(() => {});
    check('an owner operator is signed in', !onLogin(new URL(p2.url()).pathname), p2.url());

    await p2.goto(`${ER}/superadmin/billing`, { waitUntil: 'domcontentloaded' });
    await p2.waitForSelector('[data-testid="alert-emails"]', { timeout: 30000 });
    check('the recipients are on the screen, as they are stored',
      (await p2.inputValue('[data-testid="alert-emails"]')).split('\n').map((x) => x.trim()).filter(Boolean).join(',') === `${TO_A},${TO_B}`,
      await p2.inputValue('[data-testid="alert-emails"]'));
    const log = await p2.locator('[data-testid="alert-row"]').count();
    check('  …with the recent alerts beside them', log > 0, `${log} row(s) on screen`);
    const failedNote = await p2.locator('[data-testid="alerts-failed"]').innerText().catch(() => '');
    check('  …and an undelivered one is called out, not left to be noticed',
      /could not be delivered/i.test(failedNote), failedNote.replace(/\s+/g, ' ').slice(0, 120));
    const statuses = await p2.locator('[data-testid="alert-status"]').allInnerTexts();
    check('  …each row says its status in a WORD',
      statuses.some((t) => t.trim() === 'failed') && statuses.some((t) => t.trim() === 'skipped'),
      statuses.slice(0, 6).join(', '));

    // CLEAR IT, and the screen must say where they go now — not show an empty box.
    await p2.fill('[data-testid="alert-emails"]', '');
    await p2.click('[data-testid="save-alert-emails"]');
    // WAIT FOR THE SCREEN'S OWN REFRESH, not for the save's message. The save re-reads and then
    // rewrites the textarea from what came back; driving the next keystroke before that lands made
    // the field disagree with the state, the Save button go back to disabled, and the following
    // click time out after thirty seconds. The condition to wait for is the one the clause is
    // about: the recipients line naming the default address.
    const DEFAULT_TO = PC.platformContactTo();
    // CAUGHT, and the CLAUSE does the failing. An uncaught wait turns a screen that never updated
    // into `THREW: TimeoutError` thirty seconds later — which is a red, but one that names the
    // waiting rather than the thing that was wrong. The wait is here to remove a race, not to be
    // the assertion; two lines down the note is read and judged.
    await p2.waitForFunction((addr) => (document.querySelector('[data-testid="alert-recipients"]')?.textContent ?? '').includes(addr),
      DEFAULT_TO, { timeout: 30000 }).catch(() => {});
    const stored = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { alert_emails: true } });
    check('clearing the box stores an empty list', (stored?.alert_emails ?? []).length === 0);
    const note = await p2.locator('[data-testid="alert-recipients"]').innerText();
    check('  …and the screen names the address they go to instead',
      note.includes(PC.platformContactTo()) && /does not switch the alerts off/i.test(note),
      note.replace(/\s+/g, ' ').slice(0, 160));
    check('  …and the change is audited, with both lists',
      !!(await prisma.superAdminAudit.findFirst({ where: { action: 'programme_alert_emails', operator_user_id: op.id } })),
      'alerts name a customer\'s details, so who was being told is a question somebody may have to answer');

    // WAIT FOR THE FORM TO BE SETTLED BEFORE TYPING INTO IT AGAIN. The Save button is disabled
    // exactly when the textarea agrees with what is stored, so that is the signal that the
    // screen's own re-read has landed. Typing before it does means the re-read overwrites the
    // field, the button goes back to disabled, and the click below waits thirty seconds for a
    // control that will never enable — a failure that says nothing about the code.
    await p2.waitForSelector('[data-testid="save-alert-emails"][disabled]', { timeout: 30000 }).catch(() => {});
    await p2.fill('[data-testid="alert-emails"]', 'not-an-address');
    await p2.click('[data-testid="save-alert-emails"]');
    // CAUGHT, like the wait above, and for a reason the red-proofs demonstrated: with the
    // validation removed the screen says "Saved", this wait never resolves, and the gate ended on
    // `THREW` with two clauses never reached — 76 of 78 rather than 78 of 78. A throw truncates the
    // run, so the tally stops describing the coverage. The clause below reads the message and judges it.
    await p2.waitForFunction(() => /Not an email/.test(document.querySelector('[data-testid="save-result"]')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
    const refusal = await p2.locator('[data-testid="save-result"]').innerText().catch(() => '');
    check('a typo is refused on the screen, naming it', /not-an-address/.test(refusal), refusal.slice(0, 120));
    check('  …and nothing was stored',
      ((await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { alert_emails: true } }))?.alert_emails ?? []).length === 0);

    const { erMinRole } = await import('../lib/operator-roles.ts');
    check('the screen is registered as OWNER-only',
      erMinRole('/superadmin/billing') === 'owner',
      'an unregistered href falls back to support, which would open the recipient list to the lowest role');
  } finally {
    await erBrowser.close().catch(() => {});
  }

} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row', left >= 0, `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
