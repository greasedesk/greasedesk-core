/**
 * File: scripts/prospect-gate.mjs
 * A PROSPECT'S TRAIL SURVIVES THE REP; THE PERSON DOES NOT; AND NO CUSTOMER GETS PROSPECTING MAIL.
 * @gate-requires: server, db
 *
 * ── THE WORST OUTCOME, GATED DIRECTLY ───────────────────────────────────────────────────────────
 * A paying customer receiving prospecting email is the worst thing this feature can do. It is
 * asserted HERE, against the real sendNotification, before anything else — not inferred from signup
 * matching working, not inferred from the sequence stopping. The send path refuses a customer's
 * address on its own, and this proves it on its own.
 *
 * ── THIS GATE CANNOT SEND REAL MAIL, AND CHECKS THAT BEFORE IT STARTS ───────────────────────────
 * RESEND_API_KEY is blanked for this process, so the email adapter reports itself unconfigured. That
 * is also what makes the send-path clauses DISCRIMINATING: an allowed prospecting send gets past the
 * new check and stops at `not_configured`; a refused one stops earlier with its OWN code. Which code
 * comes back says which check stopped it — without one message ever reaching a provider.
 *
 * ── EVERY STOP SAYS WHY ─────────────────────────────────────────────────────────────────────────
 * The destination rule: a clause asserting a sequence stopped also asserts the REASON it stopped.
 * "Not sending" is satisfied by every wrong reason as well as the right one.
 *
 * Fixtures are GreaseDesk-level (a prospect has no tenant), on @prospect-gate.invalid addresses,
 * removed by their own ids. The one real address used is ZZ's gate owner — READ, never written.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { keyRegex } = await import('../lib/anchored-match.ts');
// BEFORE ANY NOTIFY CODE LOADS. The adapter reads this at call time, so blanking it here is enough.
process.env.RESEND_API_KEY = '';
const { gatePrisma, describeError, declineToRun, gateOrigin, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const http = await import('node:http');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const prisma = await gatePrisma();
const PR = await import('../lib/prospects.ts');
const PK = await import('../lib/prospect-keys.ts');
const ST = await import('../lib/prospect-store.ts');
const N = await import('../lib/notify.ts');
const T = await import('../lib/notification-templates.ts');
if (N.channelConfigured('email')) declineToRun('the email provider is configured in this process — refusing to run a gate that could send real prospecting mail');

const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── THE GATE NEVER TURNS THE OWNER'S SWITCH ON. IT TAKES A LEASE. ────────────────────────────────
// This database is production, and the owner's switch is global. The first version turned it ON and
// restored it in a `finally` — and a killed process runs no `finally`. SIGKILLed mid-run on 10 Sep
// 2026 (what gates.mjs does to a gate that overruns its timeout), it left sending ON for every real
// consented prospect, changed_by 'prospect-gate', with placeholder copy in the templates.
//
// So a clause that needs a real send takes a LEASE on its own fixture (ProspectSendingLease): ON for
// that one prospect, for at most five minutes, consulted only by a run that names it. A lease a killed
// run leaves behind reaches nobody else from the moment it is written, stops counting when it expires,
// and goes when its fixture is deleted. Nothing has to clean up after it for the product to be safe —
// and "KILLED MID-LEASE" below proves that by killing a process, not by reading this comment.
//
// THE ONE REMAINING WRITE TO THE OWNER'S ROW: the record-while-OFF clauses drive recordVisit, which
// creates its prospect as it goes, so no lease can exist for it beforehand. While the owner's switch is
// OFF — the default, and today's state — they need nothing written. If the owner has it ON, they
// switch it OFF for that call and put it back. Killed there, sending stays OFF: it fails CLOSED,
// visibly (the Engine Room shows "Last changed … by prospect"), and it never sends anything.
const SWITCH = 'prospect_sending';
const initialSwitch = await prisma.prospectSending.findUnique({ where: { id: SWITCH } });
const ownerOn = () => PR.sendingAllows(initialSwitch, null, { now: new Date() });
const LEASE_SECONDS = 60; // well inside SENDING_LEASE_MAX_SECONDS; a lease only has to outlive one run
const writeLease = (db, prospectId, enabled, seconds) => db.prospectSendingLease.upsert({ where: { prospect_id: prospectId },
  update: { enabled, created_at: new Date(), expires_at: new Date(Date.now() + seconds * 1000), created_by: 'prospect-gate' },
  create: { prospect_id: prospectId, enabled, created_at: new Date(), expires_at: new Date(Date.now() + seconds * 1000), created_by: 'prospect-gate' } });
const withLease = async (prospectId, enabled, fn) => {
  await writeLease(prisma, prospectId, enabled, LEASE_SECONDS);
  try { return await fn(); } finally { await prisma.prospectSendingLease.deleteMany({ where: { prospect_id: prospectId } }); }
};
const withOwnerOff = async (fn) => {
  if (!ownerOn()) return fn(); // already off for everyone: nothing is written
  await prisma.prospectSending.update({ where: { id: SWITCH }, data: { enabled: false, changed_at: new Date(), changed_by: 'prospect-gate' } });
  try { return await fn(); } finally {
    await prisma.prospectSending.update({ where: { id: SWITCH },
      data: { enabled: initialSwitch.enabled, changed_at: initialSwitch.changed_at, changed_by: initialSwitch.changed_by } });
  }
};
const REP = 'prospect-gate-rep';
const addr = (label) => `${label}-${randomUUID().slice(0, 8)}@prospect-gate.invalid`;
const made = { prospects: [], hashes: [] };
const days = (n) => n * 86_400_000;

// ── A KILLED EARLIER RUN'S FIXTURES GO BEFORE THIS RUN MAKES ITS OWN ─────────────────────────────
// A killed run's teardown never ran either, so its fixtures are still here — sequences active on
// @prospect-gate.invalid addresses, which the scheduled run would try to email the day the owner's
// switch goes on. Every fixture visit is recorded by a rep id that starts with REP, and no real rep has
// one (real ids are UUIDs); a candidate that ALSO carries a real rep's visit is not ours, and the gate
// refuses rather than delete it. (A killed run's suppression rows are hashes of random .invalid
// addresses — unfindable, and harmless: they suppress addresses nobody will ever use.)
const gateMade = { visits: { some: { rep_id: { startsWith: REP } } } };
{
  const earlier = await prisma.prospect.count({ where: gateMade });
  // THE POSITIVE CASE, PLANTED: one fixture this run does not record in `made` — exactly what a killed
  // run leaves — so the sweep is proved on a real leftover every run, not only on the runs after a kill.
  const planted = await ST.recordVisit({ repId: `${REP}-killed`, garage: { name: `Gate Garage ${randomUUID().slice(0, 6)}`, postcode: 'DY4 7LH' },
    visit: { visitedOn: new Date(), status: 'spoke_to' } });
  const leftover = await prisma.prospect.findMany({ where: gateMade,
    select: { id: true, visits: { select: { rep_id: true } }, sequence: { select: { state: true } } } });
  const notOurs = leftover.filter((p) => p.visits.some((v) => !v.rep_id.startsWith(REP)));
  if (notOurs.length) declineToRun(`${notOurs.length} prospect(s) carry a gate rep's visit AND a real rep's — not this gate's to delete`);
  await prisma.prospect.deleteMany({ where: { id: { in: leftover.map((p) => p.id) } } });
  if (earlier) console.log(`  a killed earlier run left ${earlier} fixture prospect(s) — removed before this run makes its own`);
  check('a killed run\'s fixtures are swept before this run makes its own', planted.ok && (await prisma.prospect.count({ where: gateMade })) === 0,
    `${earlier} from an earlier run, plus one planted exactly as a killed run leaves it — none left`);
}

try {
  // ── 1. THE WORST OUTCOME, FIRST AND ON ITS OWN ───────────────────────────────────────────────
  console.log('\n— a customer never receives prospecting mail —');
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, is_owner: true }, select: { email: true } });
  const toCustomer = await N.sendNotification({ recipient: owner.email, template: 'prospect_step_1', groupId: N.PLATFORM_SEND,
    data: { garageName: 'x', unsubscribeUrl: 'https://greasedesk.com/u/x' } });
  check('a prospecting email to an EXISTING CUSTOMER is refused at the send', toCustomer.skipCode === 'already_customer',
    `${toCustomer.skipCode} — refused before any provider, whatever the sequence or signup matching thought`);
  const toCustomerUpper = await N.sendNotification({ recipient: `  ${owner.email.toUpperCase()} `, template: 'prospect_step_2', groupId: N.PLATFORM_SEND,
    data: { unsubscribeUrl: 'https://greasedesk.com/u/x' } });
  check('  …and case or spacing does not get round it', toCustomerUpper.skipCode === 'already_customer', String(toCustomerUpper.skipCode));
  const toStranger = await N.sendNotification({ recipient: addr('ordinary'), template: 'prospect_step_1', groupId: N.PLATFORM_SEND,
    data: { unsubscribeUrl: 'https://greasedesk.com/u/x' } });
  check('  …while an ordinary prospect address PASSES the check', toStranger.skipCode === 'not_configured',
    `${toStranger.skipCode} — it reached the provider stage; a check that refused everything would pass the clause above`);

  // ── 2. THE CHECK IS INSIDE THE SEND PATH, KEYED ON THE TEMPLATE ──────────────────────────────
  console.log('\n— the suppression lives inside the send path —');
  const unsub = addr('unsubbed');
  const h = PK.emailHash(unsub); made.hashes.push(h);
  await prisma.prospectSuppression.create({ data: { email_hash: h, reason: 'unsubscribed' } });
  const toUnsub = await N.sendNotification({ recipient: unsub, template: 'prospect_step_1', groupId: N.PLATFORM_SEND, data: { unsubscribeUrl: 'x' } });
  check('an UNSUBSCRIBED address is refused at the send', toUnsub.skipCode === 'prospect_unsubscribed', String(toUnsub.skipCode));
  const tpls = Object.entries(T.NOTIFICATION_TEMPLATES);
  const both = tpls.filter(([, t]) => t.prospecting && t.security).map(([k]) => k);
  check('no template is both prospecting and security', both.length === 0,
    both.join(', ') || 'a security template bypasses contact preferences; a prospecting one must never inherit that');
  const notifySrc = code(readFileSync('lib/notify.ts', 'utf8'));
  // ORDER WITHIN sendNotification'S OWN BODY. The first version searched the whole file, and the first
  // "isSuppressed(groupId" in it is the function's DEFINITION, which sits above sendNotification — so
  // the clause compared a call against a declaration and failed on correct code. Tenth instance of a
  // search term matching something other than its subject.
  const sendBody = notifySrc.slice(notifySrc.indexOf('export async function sendNotification'));
  const iProspect = sendBody.indexOf('prospectingRefusal(');
  const iOptOut = sendBody.indexOf('await isSuppressed(');
  check('the check sits in sendNotification, before the opt-out check', iProspect > 0 && iOptOut > 0 && iProspect < iOptOut,
    `prospecting at ${iProspect}, opt-out at ${iOptOut} — isSuppressed returns false for every platform send, so this must not depend on it`);
  const suppSrc = code(readFileSync('lib/prospect-suppression.ts', 'utf8'));
  check('  …and it fails CLOSED', /catch\s*\{\s*return 'prospect_check_failed'/.test(suppSrc.replace(/\s+/g, ' ')),
    'an error refuses: nobody is owed prospecting mail, and a wrong send is a customer marketed to');

  // ── 3. WHAT EVERY EMAIL CARRIES ──────────────────────────────────────────────────────────────
  console.log('\n— every email identifies GreaseDesk and carries a working way out —');
  const { COMPANY } = await import('../lib/company-info.ts');
  const prospecting = tpls.filter(([, t]) => t.prospecting);
  check('the sequence has templates to send', prospecting.length === PR.SEQUENCE.length, `${prospecting.length} of ${PR.SEQUENCE.length}`);
  const bad = prospecting.filter(([, t]) => {
    const html = t.email({ garageName: 'G', unsubscribeUrl: 'https://greasedesk.com/u/TOKEN' }).html;
    return !html.includes('https://greasedesk.com/u/TOKEN') || !html.includes(COMPANY.legalName) || !html.includes(COMPANY.companyNumber);
  }).map(([k]) => k);
  check('each one carries the unsubscribe link, the legal name and the company number', bad.length === 0, bad.join(', ') || 'all three steps');
  const noLink = prospecting[0][1].email({ garageName: 'G' }).html;
  check('  …and a missing link is a VISIBLE fault, not a quiet omission', /UNSUBSCRIBE LINK MISSING/.test(noLink));

  // ── 4. NO EMAIL: NO CONSENT, NO SEQUENCE ─────────────────────────────────────────────────────
  console.log('\n— no address means no consent and no sequence —');
  const rec = async (over) => {
    const r = await ST.recordVisit({ repId: REP, garage: { name: `Gate Garage ${randomUUID().slice(0, 6)}`, postcode: 'DY4 7LH' },
      visit: { visitedOn: new Date(), status: 'spoke_to', spokeTo: 'Dave', note: 'Two ramps, busy' }, ...over });
    if (r.ok) made.prospects.push(r.prospectId);
    return r;
  };
  const seqOf = (id) => prisma.prospectSequence.findUnique({ where: { prospect_id: id } });
  const pOf = (id) => prisma.prospect.findUnique({ where: { id }, include: { visits: true } });

  const noEmail = await rec({});
  check('a visit with no email records consent as NOT ASKED', noEmail.ok && (await pOf(noEmail.prospectId)).consent === 'not_asked');
  check('  …and enters no sequence', noEmail.ok && (await seqOf(noEmail.prospectId)) === null);
  const consentNoEmail = await rec({ consent: true });
  check('consent with no address is REFUSED, not stored as a dangling yes', consentNoEmail.ok === false && consentNoEmail.code === 'consent_without_email',
    JSON.stringify(consentNoEmail));
  const declined = await rec({ email: addr('declined'), consent: false });
  check('an address the owner DECLINED to be written to enters no sequence', declined.ok && (await seqOf(declined.prospectId)) === null);
  const notAsked = await rec({ email: addr('notasked') });
  check('an address with consent NOT ASKED enters no sequence', notAsked.ok && (await seqOf(notAsked.prospectId)) === null,
    'an address is never an implication of consent');

  // ── 5. ADDRESS + AGREED: ENROLLED AT ONCE ────────────────────────────────────────────────────
  console.log('\n— an agreed address enters the sequence from the moment it is entered —');
  const agreed = await rec({ email: addr('agreed'), consent: true });
  const agreedSeq = agreed.ok ? await seqOf(agreed.prospectId) : null;
  check('an agreed address is ENROLLED', agreedSeq?.state === 'active', JSON.stringify(agreedSeq && { state: agreedSeq.state, step: agreedSeq.next_step }));
  check('  …with the consent recorded as a FACT with a time and an author',
    (await pOf(agreed.prospectId)).consent === 'agreed' && (await pOf(agreed.prospectId)).consent_at !== null && (await pOf(agreed.prospectId)).consent_by_rep_id === REP);
  check('  …and step 1 was attempted straight away, and left due because it did not go', agreedSeq?.next_step === 1 && agreedSeq?.last_sent_at === null,
    'no provider in this process — an unsent step must not be skipped as if it had been sent');

  // ── 6. SIGNUP STOPS IT, AND SAYS SO ──────────────────────────────────────────────────────────
  console.log('\n— signing up ends the sequence, and the log says that is why —');
  const signer = addr('signer');
  const willSign = await rec({ email: signer, consent: true });
  const matched = await ST.markSignedUpByEmail(signer, 'gate-group-id');
  const signedSeq = await seqOf(willSign.prospectId);
  const signedP = await pOf(willSign.prospectId);
  check('an automatic email match marks the prospect signed up', matched === 1 && signedP.status === 'signed_up' && signedP.signed_up_group_id === 'gate-group-id');
  check('  …STOPS the sequence with reason "signed_up"', signedSeq.state === 'stopped' && signedSeq.stopped_reason === 'signed_up',
    `${signedSeq.state} / ${signedSeq.stopped_reason} — the destination, not merely the removal`);
  check('  …and removes the person, keeping the garage', signedP.email === null && signedP.personal_stripped_reason === 'signed_up'
    && signedP.visits.every((v) => v.spoke_to === null) && !!signedP.garage_name && signedP.visits[0].note === 'Two ramps, busy');
  const manual = await rec({ email: addr('manual'), consent: true });
  await ST.recordVisit({ repId: REP, prospectId: manual.prospectId, visit: { visitedOn: new Date(), status: 'signed_up' } });
  const manualSeq = await seqOf(manual.prospectId);
  check('a rep marking "signed up" by hand stops it the same way', manualSeq.state === 'stopped' && manualSeq.stopped_reason === 'signed_up',
    `${manualSeq.state} / ${manualSeq.stopped_reason}`);

  // ── 7. UNSUBSCRIBE: STOPPED AT ONCE, VISIBLY, AND THE PERSON GOES ────────────────────────────
  console.log('\n— unsubscribe stops it immediately and leaves only what is needed to keep honouring it —');
  const leaver = addr('leaver');
  const willLeave = await rec({ email: leaver, consent: true });
  const token = (await prisma.prospect.findUnique({ where: { id: willLeave.prospectId }, select: { unsubscribe_token: true } })).unsubscribe_token;
  check('an enrolled prospect has an unsubscribe token', !!token && /^[A-Za-z0-9_-]{22,}$/.test(token));
  const u1 = await ST.unsubscribeByToken(token);
  const leftSeq = await seqOf(willLeave.prospectId);
  const leftP = await pOf(willLeave.prospectId);
  made.hashes.push(PK.emailHash(leaver));
  check('unsubscribe STOPS the sequence, with reason "unsubscribed"', u1.ok && leftSeq.state === 'stopped' && leftSeq.stopped_reason === 'unsubscribed' && leftSeq.stopped_at !== null,
    `${leftSeq.state} / ${leftSeq.stopped_reason} — visibly stopped, never silently absent`);
  check('  …removes the person and their email', leftP.email === null && leftP.personal_stripped_reason === 'unsubscribed' && leftP.visits.every((v) => v.spoke_to === null));
  check('  …keeps the garage and what was said about the business', leftP.garage_name.startsWith('Gate Garage') && leftP.visits[0].note === 'Two ramps, busy',
    'the ground covered survives; the person does not');
  check('  …keeps ONLY a hash, to go on honouring it', !!(await prisma.prospectSuppression.findUnique({ where: { email_hash: PK.emailHash(leaver) } })));
  const u2 = await ST.unsubscribeByToken(token);
  check('  …and a second click says it is already done', u2.ok && u2.already === true);
  const retyped = await rec({ email: leaver, consent: true });
  const retypedSeq = await seqOf(retyped.prospectId);
  check('the SAME address typed in again later never starts a sequence', retypedSeq?.state === 'stopped' && retypedSeq?.stopped_reason === 'suppressed',
    `${retypedSeq?.state} / ${retypedSeq?.stopped_reason} — recorded as never started, not silently skipped`);

  // ── 8. A CUSTOMER'S ADDRESS, AT EVERY DOOR ───────────────────────────────────────────────────
  console.log('\n— a customer address is stopped at enrolment, and by the sender —');
  const custProspect = await rec({ email: owner.email, consent: true });
  const custSeq = await seqOf(custProspect.prospectId);
  check('enrolling a customer\'s address records it as never started', custSeq?.state === 'stopped' && custSeq?.stopped_reason === 'already_customer',
    `${custSeq?.state} / ${custSeq?.stopped_reason}`);
  // AN ACTIVE SEQUENCE THAT BECOMES A CUSTOMER'S: forced into the state directly, because the product
  // path would have stopped it at enrolment. This proves the SENDER on its own.
  await prisma.prospectSequence.update({ where: { prospect_id: custProspect.prospectId },
    data: { state: 'active', stopped_at: null, stopped_reason: null, next_due_at: new Date(Date.now() - 1000) } });
  const run = await withLease(custProspect.prospectId, true, () => ST.runSequence({ onlyProspectId: custProspect.prospectId }));
  const afterRun = await seqOf(custProspect.prospectId);
  check('the SENDER stops an active sequence on a customer address', run.sent === 0 && afterRun.state === 'stopped' && afterRun.stopped_reason === 'already_customer',
    `sent ${run.sent}, ${afterRun.state} / ${afterRun.stopped_reason}`);

  // ── 9. EVERY STOPPED SEQUENCE SAYS WHY ───────────────────────────────────────────────────────
  const stopped = await prisma.prospectSequence.findMany({ where: { prospect_id: { in: made.prospects }, state: 'stopped' }, select: { stopped_reason: true, stopped_at: true } });
  check('every stopped sequence carries a reason and a time', stopped.length >= 5 && stopped.every((s) => PR.STOP_REASONS.includes(s.stopped_reason) && s.stopped_at),
    `${stopped.length} stopped — reasons: ${[...new Set(stopped.map((s) => s.stopped_reason))].join(', ')}`);

  // ── 10. THE SCHEDULE, PURE ───────────────────────────────────────────────────────────────────
  console.log('\n— the schedule, proved without a clock —');
  const t0 = new Date('2026-09-10T09:00:00Z');
  const a1 = PR.afterSend(1, t0);
  check('after step 1, step 2 is due a week later', a1.state === 'active' && a1.next_step === 2 && a1.next_due_at.getTime() - t0.getTime() === days(7));
  const aLast = PR.afterSend(PR.SEQUENCE.length, t0);
  check('after the last step it stops as "completed"', aLast.state === 'stopped' && aLast.stopped_reason === 'completed',
    'ending is a stop with a reason like every other');

  // ── 11. RETENTION, IMPLEMENTED BEFORE ANYTHING IS OLD ENOUGH ─────────────────────────────────
  console.log('\n— the person is removed 24 months after the last visit —');
  const now = new Date();
  const old = await rec({ email: addr('old'), consent: false });
  const recent = await rec({ email: addr('recent'), consent: false });
  await prisma.prospectVisit.updateMany({ where: { prospect_id: old.prospectId }, data: { visited_on: new Date(now.getTime() - days(25 * 30.5)) } });
  await prisma.prospectVisit.updateMany({ where: { prospect_id: recent.prospectId }, data: { visited_on: new Date(now.getTime() - days(23 * 30.5)) } });
  await ST.sweepRetention(now);
  const oldP = await pOf(old.prospectId), recentP = await pOf(recent.prospectId);
  check('a record 25 months past its last visit loses the person', oldP.email === null && oldP.personal_stripped_reason === 'retention');
  check('  …and keeps the garage', !!oldP.garage_name && oldP.visits.length === 1);
  check('a record 23 months past its last visit keeps the person', recentP.email !== null && recentP.personal_stripped_at === null,
    'the positive case — a sweep that stripped everything would pass the clause above');

  // ── 12. DUPLICATES: PRESENTED, NEVER MERGED ──────────────────────────────────────────────────
  console.log('\n— a second visit to one garage is a second visit, not a second garage —');
  const uniq = randomUUID().slice(0, 6);
  const first = await ST.recordVisit({ repId: REP, garage: { name: `Acme ${uniq} Motors Ltd`, postcode: 'dy4 7lh' },
    visit: { visitedOn: new Date(), status: 'interested' } });
  made.prospects.push(first.prospectId);
  const found = await ST.findMatches(`acme ${uniq} motors`, 'DY47LH');
  check('a differently-spelled entry for the same garage is PRESENTED as a match', found.some((f) => f.id === first.prospectId),
    '"Ltd", case and the postcode space all normalised away');
  check('  …and a different business on the same street is NOT', (await ST.findMatches(`Acme ${uniq} Garage`, 'DY4 7LH')).length === 0,
    'Motors and Garage are kept distinct — merging them would present a false match a tired rep may accept');
  check('  …and the match carries no person or email', found.every((f) => !('email' in f) && !('spokeTo' in f)));
  await ST.recordVisit({ repId: `${REP}-2`, prospectId: first.prospectId, visit: { visitedOn: new Date(), status: 'not_interested', note: 'Went with someone else' } });
  const merged = await pOf(first.prospectId);
  check('CONFIRMING the match adds a visit to the same garage', merged.visits.length === 2 && merged.status === 'not_interested');
  check('  …and the earlier status survives in the history', merged.visits.some((v) => v.status_at_visit === 'interested'),
    '"interested in March, not interested in May" — the trail a later reader needs');
  const rejected = await ST.recordVisit({ repId: REP, garage: { name: `Acme ${uniq} Motors`, postcode: 'DY4 7LH' }, visit: { visitedOn: new Date(), status: 'spoke_to' } });
  made.prospects.push(rejected.prospectId);
  check('REJECTING the match creates a separate record', rejected.ok && rejected.prospectId !== first.prospectId, 'the rep decides; nothing merges silently');

  // ── 13. THE SURFACES, OVER HTTP ──────────────────────────────────────────────────────────────
  console.log('\n— the unsubscribe link works, and opening it does nothing —');
  const APEX = gateOrigin();
  const live = await rec({ email: addr('link'), consent: true });
  const liveToken = (await prisma.prospect.findUnique({ where: { id: live.prospectId }, select: { unsubscribe_token: true } })).unsubscribe_token;
  made.hashes.push(PK.emailHash((await prisma.prospect.findUnique({ where: { id: live.prospectId }, select: { email: true } })).email));
  const page = await fetch(`${APEX}/u/${liveToken}`);
  const pageHtml = await page.text();
  check('the link in the email opens a page with a button', page.status === 200 && /data-testid="unsubscribe-button"/.test(pageHtml),
    String(page.status));
  const stillLive = await seqOf(live.prospectId);
  check('  …and OPENING it unsubscribes nobody', stillLive.state === 'active' && !!(await pOf(live.prospectId)).email,
    'mail scanners follow links — a GET that acted would unsubscribe people before they had read the email');
  const getApi = await fetch(`${APEX}/api/prospect-unsubscribe?t=${liveToken}`);
  check('  …and a GET on the endpoint is refused rather than acted on', getApi.status === 405, String(getApi.status));
  const oneClick = await fetch(`${APEX}/api/prospect-unsubscribe?t=${encodeURIComponent(liveToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  const afterClick = await seqOf(live.prospectId);
  check('a one-click POST — what a mail client sends from the header — unsubscribes', oneClick.status === 200
    && afterClick.state === 'stopped' && afterClick.stopped_reason === 'unsubscribed', `${oneClick.status}, ${afterClick.state} / ${afterClick.stopped_reason}`);
  const unknownTok = await fetch(`${APEX}/api/prospect-unsubscribe?t=nonexistenttokenvalue00`, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
  check('  …and an unknown token is a 404, not a quiet success', unknownTok.status === 404, String(unknownTok.status));

  const storeSrc = code(readFileSync('lib/prospect-store.ts', 'utf8'));
  const mailSrc = code(readFileSync('lib/email-service.ts', 'utf8'));
  check('every sequence email carries the one-click unsubscribe headers',
    /'List-Unsubscribe':/.test(storeSrc) && /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/.test(storeSrc) && keyRegex('headers', 'opts.headers').test(mailSrc),
    'set by the sender, and passed to the provider by lib/email-service');

  console.log('\n— the later reader has a screen, owner only and unscoped —');
  const { erMinRole } = await import('../lib/operator-roles.ts');
  check('the Engine Room screen requires the OWNER', erMinRole('/superadmin/prospects') === 'owner',
    `${erMinRole('/superadmin/prospects')} — an unregistered href falls back to 'support', so the registration IS the guard`);
  const erSrc = code(readFileSync('pages/superadmin/prospects.tsx', 'utf8'));
  check('  …asks for exactly that role', /requireOperatorPage\(ctx, \{ minRole: erMinRole\('\/superadmin\/prospects'\) \}\)/.test(erSrc));
  check('  …and applies NO region scoping', !/operatorTenantScope/.test(erSrc),
    'a prospect has no Group and no region; a scope invented now would be a wrong one');
  check('  …and says, in the file, that it moves with rep management', /reps\.greasedesk\.com/.test(readFileSync('pages/superadmin/prospects.tsx', 'utf8')));
  const noRep = await fetch(`${APEX}/api/rep/prospects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('the rep write is not reachable from the tenant host', noRep.status === 404, String(noRep.status));

  // ── 14. THE SENDING SWITCH — it stops the SEND, never the enrolment ─────────────────────────
  console.log('\n— with sending OFF, a prospect is enrolled and queued, and nothing is sent —');
  const logFor = (email) => prisma.notificationLog.findFirst({ where: { recipient: email, template: 'prospect_step_1' }, select: { status: true, error: true } });
  const qEmail = addr('queued');
  const queuedRec = await withOwnerOff(() => rec({ email: qEmail, consent: true }));
  const qSeq = await seqOf(queuedRec.prospectId);
  check('switch OFF: the prospect is still ENROLLED', qSeq?.state === 'active' && qSeq?.next_step === 1,
    `${qSeq?.state} at step ${qSeq?.next_step} — queued, not skipped`);
  check('  …and NOTHING was sent — not even attempted', (await logFor(qEmail)) === null,
    'no send-log row at all: the run held it, it did not try and fail');
  const offRun = await withLease(queuedRec.prospectId, false, () => ST.runSequence({ onlyProspectId: queuedRec.prospectId }));
  check('  …and the run SAYS sending is off, and how many it held', offRun.sending === 'off' && offRun.queued === 1 && offRun.sent === 0,
    JSON.stringify({ sending: offRun.sending, queued: offRun.queued, sent: offRun.sent }));
  check('the rep is told the follow-up is QUEUED, not on its way', queuedRec.view?.kind === 'queued' && queuedRec.view?.why === 'switched_off'
    && /QUEUED/.test(PR.sequenceSavedSentence(queuedRec.view)) && /nothing has been emailed/.test(PR.sequenceSavedSentence(queuedRec.view)),
    PR.sequenceSavedSentence(queuedRec.view ?? { kind: 'none' }).slice(0, 90));
  check('  …and never told it has started', !/has been sent|on its way|started\b/i.test(PR.sequenceSavedSentence(queuedRec.view)),
    'she has just promised a garage owner something');
  const liveRow = await prisma.prospectSequence.findUnique({ where: { prospect_id: queuedRec.prospectId } });
  check('a queued sequence RENDERS as queued, never as running', PR.sequenceView(liveRow, false).kind === 'queued'
    && PR.sequenceLabel(PR.sequenceView(liveRow, false)).startsWith('Follow-up queued'),
    PR.sequenceLabel(PR.sequenceView(liveRow, false)));
  check('  …and ON but not yet sent still reads queued', PR.sequenceView(liveRow, true).kind === 'queued',
    'active is not the same as sending — only a step that actually went reads as running');

  console.log('\n— switching sending ON starts a queued prospect from step 1 —');
  const onRun = await withLease(queuedRec.prospectId, true, () => ST.runSequence({ onlyProspectId: queuedRec.prospectId }));
  const attempted = await logFor(qEmail);
  check('switch ON: the prospect enrolled while it was OFF is sent STEP 1', onRun.sending === 'on' && attempted !== null,
    attempted ? `step 1 reached the provider stage — ${attempted.status}: ${attempted.error}` : 'no send attempted');
  check('  …it was not skipped past step 1', (await seqOf(queuedRec.prospectId)).next_step === 1
    && (await prisma.notificationLog.count({ where: { recipient: qEmail, template: { in: ['prospect_step_2', 'prospect_step_3'] } } })) === 0,
    'no provider in this process, so step 1 stays due — and no later step was attempted instead');

  console.log('\n— unsubscribe and signup still stop a QUEUED sequence —');
  const qUnsub = await withOwnerOff(() => rec({ email: addr('queued-unsub'), consent: true }));
  const qTok = (await prisma.prospect.findUnique({ where: { id: qUnsub.prospectId }, select: { unsubscribe_token: true, email: true } }));
  made.hashes.push(PK.emailHash(qTok.email));
  await ST.unsubscribeByToken(qTok.unsubscribe_token);
  const qUnsubSeq = await seqOf(qUnsub.prospectId);
  check('unsubscribe stops a QUEUED sequence, reason "unsubscribed"', qUnsubSeq.state === 'stopped' && qUnsubSeq.stopped_reason === 'unsubscribed',
    `${qUnsubSeq.state} / ${qUnsubSeq.stopped_reason} — it never needed sending on to be stoppable`);
  const qSignEmail = addr('queued-signer');
  const qSign = await withOwnerOff(() => rec({ email: qSignEmail, consent: true }));
  await ST.markSignedUpByEmail(qSignEmail, 'gate-group-id');
  const qSignSeq = await seqOf(qSign.prospectId);
  check('signup stops a QUEUED sequence, reason "signed_up"', qSignSeq.state === 'stopped' && qSignSeq.stopped_reason === 'signed_up',
    `${qSignSeq.state} / ${qSignSeq.stopped_reason}`);

  // ── 15. A LEASE REACHES ONE PROSPECT, AND SURVIVES ITS WRITER BEING KILLED ───────────────────
  console.log('\n— a gate\'s lease reaches its own prospect and nobody else —');
  const leaseNow = new Date();
  const LEASE_A = { prospect_id: 'fixture-a', enabled: true, expires_at: new Date(leaseNow.getTime() + 60_000) };
  check('an ON lease reaches ITS prospect', PR.sendingAllows(null, LEASE_A, { now: leaseNow, prospectId: 'fixture-a' }) === true,
    'the positive case, in the same run — every clause below would pass on a lease that never applied');
  check('  …and no OTHER prospect', PR.sendingAllows(null, LEASE_A, { now: leaseNow, prospectId: 'fixture-b' }) === false);
  check('  …and no run that names none — which is every scheduled run', PR.sendingAllows(null, LEASE_A, { now: leaseNow }) === false);
  check('  …and nobody once it expires', PR.sendingAllows(null, LEASE_A, { now: LEASE_A.expires_at, prospectId: 'fixture-a' }) === false);
  check('an OFF lease holds its prospect while the owner\'s switch is ON — and only that one',
    PR.sendingAllows({ enabled: true }, { ...LEASE_A, enabled: false }, { now: leaseNow, prospectId: 'fixture-a' }) === false
    && PR.sendingAllows({ enabled: true }, { ...LEASE_A, enabled: false }, { now: leaseNow, prospectId: 'fixture-b' }) === true);
  check('NO ROW is OFF, for everyone and for any one prospect',
    PR.sendingAllows(null, null, { now: leaseNow }) === false && PR.sendingAllows(null, null, { now: leaseNow, prospectId: 'fixture-a' }) === false,
    'absence is the default — "never switched on" is a state, not a value somebody wrote');
  check('every run asks about the prospect it is running', /prospectSendingEnabled\(db, \{ prospectId: opts\.onlyProspectId \}\)/.test(storeSrc)
    && /prospectSendingEnabled\(db, \{ prospectId \}\)/.test(storeSrc),
    'runSequence and recordVisit name their prospect; the scheduled run names none, so no lease reaches it');

  // ONE PROBE PER TRANSACTION, each rolled back — a caught violation poisons the transaction it is in.
  const probeLease = (seconds) => prisma.$transaction(async (tx) => {
    try {
      await tx.$executeRawUnsafe(`INSERT INTO "ProspectSendingLease" (prospect_id, enabled, created_at, expires_at, created_by)
        VALUES ($1, true, now(), now() + make_interval(secs => $2), 'probe')`, custProspect.prospectId, seconds);
    } catch (e) { throw new Error(`ROLLBACK refused ${e.meta?.message ?? e.message}`); }
    throw new Error('ROLLBACK accepted');
  }).catch((e) => String(e.message));
  const long = await probeLease(PR.SENDING_LEASE_MAX_SECONDS + 60);
  const fine = await probeLease(PR.SENDING_LEASE_MAX_SECONDS - 60);
  const zero = await probeLease(0);
  check('the DATABASE refuses a lease longer than five minutes', /refused/.test(long) && /ProspectSendingLease_short_chk/.test(long),
    `${PR.SENDING_LEASE_MAX_SECONDS + 60}s refused by ${(long.match(/ProspectSendingLease_\w+/) ?? ['nothing'])[0]} — a year-long "lease" would be an open switch in disguise`);
  check('  …and takes one inside it', fine === 'ROLLBACK accepted', `${PR.SENDING_LEASE_MAX_SECONDS - 60}s: ${fine.slice(0, 60)}`);
  check('  …and refuses one that has already ended', /refused/.test(zero) && /ProspectSendingLease_short_chk/.test(zero), `0s refused by ${(zero.match(/ProspectSendingLease_\w+/) ?? ['nothing'])[0]}`);

  console.log('\n— KILLED MID-LEASE: a process that dies holding a lease leaves nothing that reaches anyone else —');
  // A REAL PROCESS, REALLY KILLED. It writes its lease with the gate's own writeLease — the same code,
  // passed as source — reports that it holds it, and waits. It is then SIGKILLed, exactly as gates.mjs
  // kills a gate that overruns: no `finally`, no handler, nothing of it runs again. Every clause below
  // is about what that leaves behind.
  const victim = queuedRec.prospectId; // a fixture: active, due, consented
  const bystander = (await withOwnerOff(() => rec({ email: addr('bystander'), consent: true }))).prospectId;
  const { spawn } = await import('node:child_process');
  // The child takes its client from gatePrisma like every gate (Rule G: pool limits, transient retry).
  // Its stdout is a pipe back to this gate, so it says so: GATE_ALLOW_PIPE is the preflight's own opt-in.
  const childSrc = `await import('./scripts/_ts.mjs');
const { gatePrisma } = await import('./scripts/_gate-preflight.mjs');
const db = await gatePrisma();
const writeLease = ${writeLease.toString()};
await writeLease(db, ${JSON.stringify(victim)}, true, ${LEASE_SECONDS});
console.log('LEASED');
setInterval(() => {}, 1 << 30);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSrc], { cwd: process.cwd(), env: { ...process.env, GATE_ALLOW_PIPE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErr = ''; child.stderr.on('data', (d) => { childErr += d; });
  const childExit = new Promise((r) => child.on('exit', (code, sig) => r(sig ?? `code ${code}`)));
  const held = await new Promise((r) => { let buf = ''; child.stdout.on('data', (d) => { buf += d; if (buf.includes('LEASED')) r(true); }); childExit.then(() => r(false)); });
  child.kill('SIGKILL');
  const how = await childExit;
  const leftLease = await prisma.prospectSendingLease.findUnique({ where: { prospect_id: victim } });
  check('the writer was SIGKILLed while holding its lease', held && how === 'SIGKILL' && leftLease !== null,
    !held ? `it never took a lease: ${(childErr.split('\n').find((l) => /Error/.test(l)) ?? childErr.trim().split('\n').pop() ?? '').trim()}`
      : !leftLease ? `${how}, but there is no lease on the victim — the writer leased something else`
      : `${how}; the lease is still there — nothing of the writer ran after the kill`);
  const ownerNow = await prisma.prospectSending.findUnique({ where: { id: SWITCH } });
  check('  …the OWNER\'S switch is exactly as found', initialSwitch ? ownerNow?.changed_at?.getTime() === initialSwitch.changed_at.getTime() : ownerNow === null,
    initialSwitch ? `enabled=${ownerNow?.enabled}, by ${ownerNow?.changed_by}` : 'no row — never switched on, and still not');
  check('  …the killed lease still reaches its own prospect', (await ST.prospectSendingEnabled(undefined, { prospectId: victim })) === true,
    'the positive case: it is a live lease, so the clauses below are about a lease that works');
  check('  …a run that names no prospect — the scheduled run — does not see it', (await ST.prospectSendingEnabled()) === ownerOn(),
    `reads ${ownerOn() ? 'ON' : 'OFF'}, the owner's answer, not the lease's`);
  check('  …nor does any other prospect', (await ST.prospectSendingEnabled(undefined, { prospectId: bystander })) === ownerOn(),
    'a real consented prospect queued beside it stays exactly as the owner left it');
  // THE ACTUAL SCHEDULED RUN — only while nothing REAL is due. It is the real function against the
  // production table: under a regression that let the lease through, it would claim every due sequence.
  // No mail can go (the gate refuses to run with a provider configured), but it would log and re-time
  // real prospects' rows. With real ones due, the reader clause above carries it, and this says so.
  const realDue = await prisma.prospectSequence.count({ where: { state: 'active', next_due_at: { lte: new Date() }, NOT: { prospect: gateMade } } });
  if (realDue) console.log(`  (the actual scheduled run is not driven: ${realDue} real sequence(s) are due — the reader clause above covers it)`);
  if (!ownerOn() && realDue === 0) {
    const cronRun = await ST.runSequence();
    const byRun = await ST.runSequence({ onlyProspectId: bystander });
    check('  …and the scheduled run, and a run for the prospect beside it, send NOTHING', cronRun.sending === 'off' && cronRun.sent === 0 && byRun.sending === 'off' && byRun.sent === 0,
      `scheduled: ${cronRun.sending}, ${cronRun.queued} held; bystander: ${byRun.sending}`);
  }
  check('  …and once it expires it reaches nobody at all', !!leftLease && PR.sendingAllows(initialSwitch, leftLease, { now: leftLease.expires_at, prospectId: victim }) === ownerOn()
    && leftLease.expires_at.getTime() - leftLease.created_at.getTime() <= PR.SENDING_LEASE_MAX_SECONDS * 1000,
    leftLease ? `expires ${Math.round((leftLease.expires_at - leftLease.created_at) / 1000)}s after it was written — no cleanup needed for that` : 'no lease was left to expire');
  made.victimLease = victim; // left in place: teardown proves it goes WITH its fixture

  console.log('\n— the switch is visible where it matters, and defaults OFF —');
  const storeSrc2 = code(readFileSync('lib/prospect-store.ts', 'utf8'));
  if (!initialSwitch) check('  …and on this database it has never been switched on', (await ST.prospectSendingEnabled()) === false);
  check('switching it is AUDITED', keyRegex('action', "opts.enabled ? 'prospect_sending.on' : 'prospect_sending.off'").test(storeSrc2),
    'turning it on emails real people; who and when goes to SuperAdminAudit');
  const erSrc2 = code(readFileSync('pages/superadmin/prospects.tsx', 'utf8'));
  check('the Engine Room shows the switch and what it is holding', /data-testid="er-sending-state"/.test(erSrc2) && /queued/.test(erSrc2),
    'not an env var nobody reads');
  check('  …and every row reads the shared view', /sequenceLabel\(sequenceView\(/.test(erSrc2) && /sequenceLabel\(sequenceView\(/.test(code(readFileSync('pages/rep/prospects/index.tsx', 'utf8'))),
    'the Engine Room and the rep\'s list cannot disagree about what "queued" means');
  check('  …and the API only takes an explicit true or false', /typeof req\.body\?\.enabled !== 'boolean'/.test(code(readFileSync('pages/api/superadmin/prospect-sending.ts', 'utf8'))),
    '"switch on" must never be the accidental reading of a malformed request');
  // THE BEHAVIOUR IS PROVED ABOVE (offRun returned sending:'off' with its count). This only confirms the
  // scheduled job hands that object straight back as its output rather than summarising it away. The
  // first version looked for \`sending: 'off'\` — the code says \`out.sending = 'off'\` — and failed on
  // spelling, not behaviour.
  const cronSrc = code(readFileSync('pages/api/cron/prospect-sequence.ts', 'utf8'));
  check('the scheduled run reports the switch in its output', /const sequence = await runSequence\(\{ now \}\);/.test(cronSrc)
    && /json\(\{ ok: true, sequence,/.test(cronSrc), 'the run object — sending and queued included — is the response');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.prospects.length) await prisma.prospect.deleteMany({ where: { id: { in: made.prospects } } });
    if (made.hashes.length) await prisma.prospectSuppression.deleteMany({ where: { email_hash: { in: made.hashes } } });
    const left = await prisma.prospect.count({ where: { id: { in: made.prospects } } });
    check('teardown removed every fixture', left === 0, `${made.prospects.length} prospects made, ${left} left`);
    const leases = await prisma.prospectSendingLease.count({ where: { prospect_id: { in: made.prospects } } });
    check('every lease went with its fixture — the killed one included', leases === 0 && !!made.victimLease,
      made.victimLease ? `${leases} left; the killed writer's lease was never deleted by hand` : 'the kill clause never reached its lease');
    const nowSwitch = await prisma.prospectSending.findUnique({ where: { id: SWITCH } });
    check('the OWNER\'S switch is exactly as the gate found it',
      initialSwitch ? (nowSwitch?.enabled === initialSwitch.enabled && nowSwitch?.changed_at.getTime() === initialSwitch.changed_at.getTime()) : nowSwitch === null,
      initialSwitch ? `enabled=${nowSwitch?.enabled}, by ${nowSwitch?.changed_by}` : 'no row, as before — never switched on, and nothing was written to it');
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
