/**
 * File: scripts/intake-escalation-gate.mjs
 * THE EMAIL THAT MAKES THE PROMPTS MEAN SOMETHING — and the silences that keep it readable.
 *
 * lib/intake-items argues that a prompt must never be a gate, because a hard gate gets worked
 * around and the data ends up LOOKING captured when it isn't. That argument only holds if something
 * supplies the pressure instead. For a fortnight nothing did: `intakeOutstanding` had zero callers.
 *
 * Most of these assertions are about when it does NOT send. An escalation that also fires on
 * success is a newsletter, and the one thing that kills this design is a manager who stops reading.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const E = await import('../lib/intake-escalation.ts');
const I = await import('../lib/intake-items.ts');
const T = await import('../lib/notification-templates.ts');
const { readFileSync } = await import('node:fs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const prisma = await gatePrisma();
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
const st = (item, o) => ({ item, prompted: true, done: false, skipped: false, skipReason: null, ...o });

let fix = null, browser = null;

try {
  // ── 1. THREE STATES, THREE SENTENCES ─────────────────────────────────────────────────────────
  // A skip with a reason, a skip without one, and an item nobody touched are the same GAP and three
  // different conversations. Collapsing them loses what makes the mail actionable.
  console.log('\n— what a manager reads —');
  const lines = E.outstandingLines([
    st('diag_scan', { skipped: true, skipReason: 'scanner faulty' }),
    st('walkaround', { skipped: true }),
    st('oil_level'),
  ]);
  check('a skip WITH a reason gives the reason', /Diagnostic scan — skipped: scanner faulty/.test(lines[0]), lines[0]);
  check('  …so the manager knows to fix a scanner', /scanner faulty/.test(lines[0]));
  check('a skip WITHOUT one says so plainly', /Walkaround video — skipped, no reason given/.test(lines[1]), lines[1]);
  check('an untouched item is different again', /Oil level — not done/.test(lines[2]), lines[2]);
  check('  …so the manager knows somebody walked past it', lines[1] !== lines[2] && !/skipped/.test(lines[2]));
  check('every item has a human name, not a key',
    E.outstandingLines(I.INTAKE_ITEMS.map((i) => st(i))).every((l) => !/_/.test(l.split(' — ')[0])),
    E.outstandingLines(I.INTAKE_ITEMS.map((i) => st(i))).map((l) => l.split(' — ')[0]).join(', '));

  // ── 2. THE SILENCES ──────────────────────────────────────────────────────────────────────────
  console.log('\n— and when it says nothing at all —');
  const site = await zzSite(prisma);
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76ESC', make: 'Esc', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { veh: veh.id, card: card.id };
  const base = { groupId: ZZ, jobCardId: card.id, registration: 'ZZ76ESC', vehicleDesc: 'Esc Fixture', mechanic: 'Gate' };

  const allDone = await E.escalateOutstandingIntake(prisma, { ...base, states: I.INTAKE_ITEMS.map((i) => st(i, { done: true })) });
  check('nothing outstanding sends NOTHING', allDone.sent === false && allDone.reason === 'nothing_outstanding',
    'an escalation that also fires on success is a newsletter');
  const unprompted = await E.escalateOutstandingIntake(prisma, { ...base, states: I.INTAKE_ITEMS.map((i) => st(i, { prompted: false })) });
  check('an UNPROMPTED item is never named', unprompted.sent === false,
    'emailing about a scan nobody was asked for is the false positive that kills the whole design');
  const spent = await E.escalateOutstandingIntake(prisma, { ...base, states: [st('diag_scan', { skipped: true, skipReason: 'x', done: true })] });
  check('a skip the artefact later satisfied is spent', spent.sent === false,
    'skipped at 09:30 and done at 10:00 is simply done');

  // NO RECIPIENT IS NOT A FAILURE — and must not invent one.
  //
  // Proven against a STUB, not by nulling a live tenant's addresses. The first version captured
  // them and restored them afterwards, which is the documented pattern for singleton rows — and it
  // was still wrong here: billing_email is NOT NULL, so the mutation threw before applying and the
  // restore never ran. Nothing was damaged only because the column refused. Had it been nullable,
  // an exception between mutate and restore would have left ZZ with no ops chain at all, silently.
  // A read-only branch does not need a live row to prove it.
  const emptyDb = { group: { findUnique: async () => ({ ops_email: null, invoice_reply_to: null, billing_email: null }) } };
  const noAddr = await E.escalateOutstandingIntake(emptyDb, { ...base, states: [st('diag_scan')] });
  check('no ops address sends nothing, and says why', noAddr.sent === false && noAddr.reason === 'no_recipient',
    'a garage that gave us no address has not asked to be emailed; inventing one mails somebody who never opted in');
  const zz = await prisma.group.findUnique({ where: { id: ZZ }, select: { ops_email: true, invoice_reply_to: true, billing_email: true } });
  check('  …and this gate never touched the tenant’s own addresses', zz.billing_email != null, JSON.stringify(zz));

  // ── 3. IT DOES SEND, TO THE RIGHT PLACE ──────────────────────────────────────────────────────
  console.log('\n— and when it does —');
  const logBefore = await prisma.notificationLog.count({ where: { group_id: ZZ, template: 'intake_outstanding' } });
  const sent = await E.escalateOutstandingIntake(prisma, {
    ...base, states: [st('diag_scan', { skipped: true, skipReason: 'scanner faulty' }), st('oil_level')],
  });
  check('two outstanding items send one email', sent.sent === true && sent.count === 2, JSON.stringify(sent));
  check('  …to the ops chain, not a guessed address', typeof sent.recipient === 'string' && sent.recipient.includes('@'), sent.recipient);
  const logAfter = await prisma.notificationLog.count({ where: { group_id: ZZ, template: 'intake_outstanding' } });
  check('  …and it is recorded whatever the provider did', logAfter === logBefore + 1, `${logBefore} → ${logAfter}`);

  // ── AND IT ACTUALLY FIRES, THROUGH THE SERVED ENDPOINT ───────────────────────────────────────
  // The structural checks below read the handler's TEXT, which survives the trigger being disabled
  // — a probe wrapping the condition in `if (false && …)` left them all green. Only advancing a
  // real card proves the wiring, so that is what this does.
  console.log('\n— advancing a real card —');
  const pSite = await prisma.site.create({
    data: { group_id: ZZ, site_name: 'ZZ Escalation Site', intake_prompt_diag_scan: true },
    select: { id: true },
  });
  fix.site = pSite.id;
  const pVeh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76ESC2', make: 'Esc', model: 'Two' }, select: { id: true } });
  const pCard = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: pSite.id, vehicle_id: pVeh.id, status: 'accepted', stage_details_done: true },
    select: { id: true },
  });
  fix.veh2 = pVeh.id; fix.card2 = pCard.id;

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const beforeSend = await prisma.notificationLog.count({ where: { group_id: ZZ, template: 'intake_outstanding' } });
  const resp = await page.evaluate(async (id) => {
    const r = await fetch('/api/jobcard-stage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ jobCardId: id, stage: 'intake', done: true }),
    });
    return { status: r.status };
  }, pCard.id);
  check('the advance itself succeeds', resp.status === 200, `HTTP ${resp.status}`);
  let afterSend = beforeSend;
  for (let i = 0; i < 30; i++) {
    afterSend = await prisma.notificationLog.count({ where: { group_id: ZZ, template: 'intake_outstanding' } });
    if (afterSend > beforeSend) break;
    await page.waitForTimeout(500);
  }
  check('  …and marking intake done with a prompted item undone SENDS', afterSend === beforeSend + 1,
    `${beforeSend} → ${afterSend}`);

  // AND ADVANCING A CLEAN CARD DOES NOT. The silence proven through the same path as the send.
  const cleanBefore = afterSend;
  await page.evaluate(async (id) => {
    await fetch('/api/jobcard-stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ jobCardId: id, stage: 'intake', done: false }) });
    await fetch('/api/jobcard-stage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ jobCardId: id, stage: 'injob', done: true }) });
  }, pCard.id);
  await page.waitForTimeout(2500);
  check('  …while advancing a DIFFERENT stage sends nothing',
    (await prisma.notificationLog.count({ where: { group_id: ZZ, template: 'intake_outstanding' } })) === cleanBefore,
    'only intake-marked-done, not the other three and not an undo');

  const html = T.NOTIFICATION_TEMPLATES.intake_outstanding.email({
    registration: 'ZZ76ESC', vehicleDesc: 'Esc Fixture', mechanic: 'Gate', count: 2,
    itemsHtml: '<li>Diagnostic scan — skipped: scanner faulty</li>', link: null,
  });
  check('the subject names the car and the count', /ZZ76ESC/.test(html.subject) && /2 intake items/.test(html.subject), html.subject);
  check('the body says nothing was blocked', /Nothing was blocked/.test(html.html),
    'a prompt is not a gate, and an email that reads like an alarm gets filtered');
  check('  …and that there may still be time', /still be time/.test(html.html), 'the whole point of firing on the advance');
  check('there is no SMS on this template', T.NOTIFICATION_TEMPLATES.intake_outstanding.sms === undefined);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    // AuditLog and NotificationLog are append-only. The send row for this fixture stays, correctly.
    const vehIds = [fix.veh, fix.veh2].filter(Boolean);
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: [fix.card, fix.card2].filter(Boolean) } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vehIds } } }));
    await step('site', () => (fix.site ? prisma.site.delete({ where: { id: fix.site } }) : Promise.resolve()));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, id: { in: vehIds } } })) === 0
      && (await prisma.site.count({ where: { group_id: ZZ, site_name: { contains: 'Escalation' } } })) === 0);
  }
}

// ── 4. THE TRIGGER, AND THE ONE THAT IS NOT BUILT ───────────────────────────────────────────────
console.log('\n— fired on the advance, not overnight —');
const handler = readFileSync('pages/api/jobcard-stage.ts', 'utf8');
check('it fires only when INTAKE is marked done', /stage === 'intake' && done === true && !skip/.test(handler),
  'not on a skip of the whole stage, not on an undo, not on the other three');
// The CALL SITE, not the import. indexOf found `import { escalateOutstandingIntake }` at the top
// of the file and compared that — an assertion that would have passed with the call anywhere.
check('  …AFTER the transaction, never inside it',
  handler.indexOf('await escalateOutstandingIntake(') > handler.indexOf('await prisma.$transaction'),
  'a provider wobble must not roll back a mechanic’s advance');
check('  …and a send failure is swallowed', /catch \(e\) \{\s*console\.error\('\[intake-escalation\]/.test(handler));
check('there is no cron for this', !/intake/.test(readFileSync('vercel.json', 'utf8')),
  'an email that evening is a report, not an intervention');

const esc = readFileSync('lib/intake-escalation.ts', 'utf8');
check('the deferred sweep is marked NOT BUILT, in those words', /NOT BUILT — THE SWEEP/.test(esc),
  'intent must be unmistakable for a description — five files got that wrong in this feature');
check('  …and its filter is recorded so nobody re-derives it',
  /booking day has passed/.test(prose(esc)) && /at least one prompt enabled/.test(prose(esc))
  && /cancelled/.test(prose(esc)) && /never advanced/.test(prose(esc)));
check('  …with the measured reason it is deferred', /82% false-positive/.test(prose(esc)));

console.log('\n— the five present-tense claims —');
for (const f of ['lib/oil-level.ts', 'lib/intake-items.ts', 'pages/api/intake-items.ts',
                 'components/pwa/PhoneIntakeChecklist.tsx', 'components/jobcard/IntakeChecklist.tsx']) {
  const p = prose(readFileSync(f, 'utf8'));
  check(`${f.split('/').pop()} now names the sender`, /lib\/intake-escalation/.test(p));
}
check('and the rule itself is written down',
  /must be distinguishable from one saying what it is FOR/.test(prose(readFileSync('lib/intake-items.ts', 'utf8'))));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
