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
const REP = 'prospect-gate-rep';
const addr = (label) => `${label}-${randomUUID().slice(0, 8)}@prospect-gate.invalid`;
const made = { prospects: [], hashes: [] };
const days = (n) => n * 86_400_000;

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
  const run = await ST.runSequence({ onlyProspectId: custProspect.prospectId });
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
  await ST.recordVisit({ repId: 'another-rep', prospectId: first.prospectId, visit: { visitedOn: new Date(), status: 'not_interested', note: 'Went with someone else' } });
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
    /'List-Unsubscribe':/.test(storeSrc) && /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/.test(storeSrc) && /headers: opts\.headers/.test(mailSrc),
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
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.prospects.length) await prisma.prospect.deleteMany({ where: { id: { in: made.prospects } } });
    if (made.hashes.length) await prisma.prospectSuppression.deleteMany({ where: { email_hash: { in: made.hashes } } });
    const left = await prisma.prospect.count({ where: { id: { in: made.prospects } } });
    check('teardown removed every fixture', left === 0, `${made.prospects.length} prospects made, ${left} left`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
