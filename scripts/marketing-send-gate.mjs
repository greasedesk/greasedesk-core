/**
 * File: scripts/marketing-send-gate.mjs
 * THE ROW SENDS — two variants, two channels, and a record that follows what actually went.
 *
 * ── WHAT THIS GATE CANNOT PROVE ─────────────────────────────────────────────────────────────────
 * No SMS or email provider is configured locally, so nothing here reaches a phone or an inbox.
 * That makes the local run exercise the REFUSAL side of every send — which is the side that must
 * never quietly mark a car contacted. The words themselves are proven against the template
 * renderers, and the segment counts are MEASURED through smsText, which is what notify transmits.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const T = await import('../lib/notification-templates.ts');
const S = await import('../lib/sms-text.ts');
const MT = await import('../lib/message-threads.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const REG = 'ZZ76SND';
const CUST = 'Marketing Send Fixture';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

// The longest real tenant name today (24 chars) — the budget must hold at the worst live case.
const LONGEST = 'Marketbridge Motor Works';
const D = (name) => ({ garageName: name, garagePhone: '01454 412000', customerName: 'Sam Fixture',
  registration: 'AB12CDE', vehicleDesc: 'MINI Cooper', expiryDate: '25 August 2026' });

let fix = null, browser = null;

try {
  // ── 1. TWO VARIANTS, BECAUSE AN EXPIRED CAR IS OFF THE ROAD ──────────────────────────────────
  console.log('\n— the words —');
  const due = S.smsText(T.NOTIFICATION_TEMPLATES.mot_due.sms(D(LONGEST)).text);
  const exp = S.smsText(T.NOTIFICATION_TEMPLATES.mot_expired.sms(D(LONGEST)).text);
  check('the due text says the MOT runs out, and offers to book', /runs out 25 August 2026/.test(due) && /book you in/.test(due), due);
  check('the expired text says it RAN out, and that the car is not road legal',
    /ran out 25 August 2026/.test(exp) && /not road legal/.test(exp), exp);
  check('  …and never says "illegal"', !/illegal/.test(exp),
    'accurate, and it does not accuse someone who simply has not noticed');
  check('neither carries urgency language', !/(fine|caught|penalty|urgent|immediately)/i.test(due + exp),
    'the fact does the work; a reminder that reads like a scare gets ignored the second time');
  check('neither offers a link', !/(https?:|www\.|tap|click)/i.test(due + exp),
    'every magic link binds to a job card, and a car whose owner has not booked has none');
  check('both carry the reply route, since our sender is one-way', /To reply, call 01454 412000/.test(due)
    && /To reply, call 01454 412000/.test(exp));
  check('  …and omit it rather than faking one when no number is on file',
    !/To reply/.test(T.NOTIFICATION_TEMPLATES.mot_due.sms({ ...D(LONGEST), garagePhone: null }).text));

  // ── 2. THE SEGMENT BUDGET, MEASURED AT THE LONGEST REAL NAME ─────────────────────────────────
  console.log('\n— one segment, measured —');
  const cDue = S.smsCost(due), cExp = S.smsCost(exp);
  check(`the due variant is one segment at a ${LONGEST.length}-character name`, cDue.segments === 1,
    `${cDue.septets} of 160, ${cDue.encoding}`);
  check(`the expired variant is one segment at a ${LONGEST.length}-character name`, cExp.segments === 1,
    `${cExp.septets} of 160, ${cExp.encoding}`);
  // THE FALLBACK IS NOT DEAD CODE. Proven by a name long enough to need it, so a future edit that
  // deletes the shortening silently is caught.
  const longName = 'X'.repeat(40);
  const expLong = S.smsText(T.NOTIFICATION_TEMPLATES.mot_expired.sms(D(longName)).text);
  check('a 40-character garage name drops the spare clause rather than a second segment',
    S.smsCost(expLong).segments === 1 && !/We can sort it/.test(expLong) && /not road legal/.test(expLong),
    `${S.smsCost(expLong).septets} of 160`);
  check('  …and the full clause is present when it fits', /We can sort it/.test(exp),
    'shortened only when it must be, not as the default');
  // TYPOGRAPHY IS FOLDED AT THE RENDER POINT, not by the template author remembering.
  check('the em dash is folded to a hyphen before transmission', !/—/.test(due) && /- give us a ring/.test(due),
    'an unfolded em dash forces UCS-2 and triples the cost without changing a word');
  check('  …and the unfolded body would genuinely have cost more',
    S.smsCost(T.NOTIFICATION_TEMPLATES.mot_due.sms(D(LONGEST)).text).segments > 1,
    'otherwise the fold above proves nothing');

  // ── 3. expiryDate, NOT dueLabel ──────────────────────────────────────────────────────────────
  console.log('\n— the date field the sentence needs —');
  const DU = await import('../lib/due-items.ts');
  check('dueLabel is a complete phrase and would read wrong inside the sentence',
    DU.dueLabel({ dueBasis: 'date', dueDate: '2026-08-25', dueMileage: null, dueDatePrecision: 'day' }) === 'due by 25 August 2026',
    'runs out due by 25 August 2026 — which is why these templates take a bare expiryDate');
  check('  …and the templates do not use it', !/due by/.test(due + exp));

  // ── 4. A MESSAGE ABOUT A CAR THREADS UNDER THE CAR ───────────────────────────────────────────
  console.log('\n— where the reply will land —');
  // phone_e164 IS SET, so the SMS path reaches the provider check rather than stopping at "no
  // number" — otherwise the refusal assertion below would pass while proving something else.
  // +447700900456 is in Ofcom's reserved drama range: it cannot reach a real handset even if a
  // provider were configured. Email is deliberately ABSENT, which is what the panel's
  // missing-address wording is proven against.
  const cust = await prisma.customer.create({
    data: { group_id: ZZ, name: CUST, phone: '07700 900456', phone_e164: '+447700900456' }, select: { id: true } });
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Fixture', model: 'Send',
      year: 2015, mot_expiry: new Date('2026-08-25T00:00:00.000Z') },
    select: { id: true },
  });
  fix = { veh: veh.id, cust: cust.id };
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });

  const key = await MT.threadKeyForSubject(prisma, 'vehicle', veh.id);
  check('a vehicle subject resolves to a thread key', key?.vehicleId === veh.id && key?.customerId === cust.id && key?.groupId === ZZ,
    JSON.stringify(key));
  check('  …and an unowned car does not invent a conversation with nobody',
    (await MT.threadKeyForSubject(prisma, 'vehicle', (await prisma.vehicle.create({
      data: { group_id: ZZ, registration: 'ZZ76NOO', registration_normalized: 'ZZ76NOO' }, select: { id: true } })).id)) === null);
  check('  …and an unknown subject type is still nothing', await MT.threadKeyForSubject(prisma, 'user', cust.id) === null,
    'staff mail is not a customer conversation');

  // ── 5. ON THE SERVED PAGE ────────────────────────────────────────────────────────────────────
  console.log('\n— two presses, never one —');
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  // ?stack=warm — the fixture's MOT is days away, not lapsed, so the board puts it in Warm and the
  // page lands on Hot. Navigating to the tab the car is actually in is what a garage would do, and
  // it documents which stack this fixture belongs to.
  await page.goto(`${BASE}/admin/marketing?stack=warm`, { waitUntil: 'domcontentloaded' });
  const row = page.locator(`[data-testid="marketing-row-${veh.id}"]`);
  await row.waitFor({ timeout: 25000 });
  check('the row offers to send', await row.locator('[data-testid="marketing-send-open"]').count() === 1);
  check('  …and nothing is sent before it is opened',
    await row.locator('[data-testid="marketing-send-panel"]').count() === 0
    && (await prisma.notificationLog.count({ where: { group_id: ZZ, subject_id: veh.id } })) === 0);

  await row.locator('[data-testid="marketing-send-open"]').click();
  await row.locator('[data-testid="marketing-send-panel"]').waitFor({ timeout: 25000 });
  const preview = (await row.locator('[data-testid="marketing-send-preview"]').textContent() ?? '').trim();
  check('the panel shows the words that will arrive', /ZZ76SND/.test(preview) && /25 August 2026/.test(preview), preview);
  check('  …rendered by the server, so they cannot differ from what is sent',
    /ZZ Gate Garage: your MOT on ZZ76SND runs out 25 August 2026/.test(preview),
    'the panel does not assemble its own copy of the sentence');
  check('  …with the cost stated in texts, not septets alone',
    /of 160/.test(await row.locator('[data-testid="marketing-send-cost"]').textContent() ?? ''));
  check('opening the panel still sends nothing',
    (await prisma.notificationLog.count({ where: { group_id: ZZ, subject_id: veh.id } })) === 0,
    'one press on a list of two hundred rows must not put words on a customer’s phone');
  // NO EMAIL ON THIS FIXTURE, and the row says which problem that is.
  const emailLabel = await row.locator('[data-testid="marketing-send-email"]').textContent() ?? '';
  check('a missing address is named as a missing address', /No email address on file/.test(emailLabel), emailLabel.trim());
  check('  …while the channel that CAN reach them offers no excuse',
    !/on file|opted out/.test(await row.locator('[data-testid="marketing-send-sms"]').textContent() ?? ''),
    'this fixture has a mobile number, so nothing is refused on that side');

  // ── 6. A SEND THAT DID NOT GO DOES NOT MARK THE CAR CONTACTED ────────────────────────────────
  console.log('\n— the record follows what actually went —');
  const post = (body) => page.evaluate(async (b) => {
    const r = await fetch('/api/marketing-send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);
  const attempt = await post({ vehicleId: veh.id, channels: ['sms'] });
  // NAMED FOR WHAT IT PROVES. The local box has no SMS provider, so this is the not_configured
  // branch specifically — asserted by code, not inferred from ok===false, which every other
  // refusal also satisfies.
  check('with no SMS provider on this box the send is refused as not_configured',
    attempt.status === 200 && attempt.body.results?.sms?.ok === false
    && attempt.body.results?.sms?.code === 'not_configured', JSON.stringify(attempt.body.results));
  check('  …in a sentence a garage can act on, not a code',
    /text/i.test(attempt.body.results?.sms?.message ?? ''), attempt.body.results?.sms?.message);
  check('  …and the car is NOT marked contacted',
    (await prisma.marketingContact.count({ where: { group_id: ZZ, vehicle_id: veh.id } })) === 0,
    'marking it would drop the car off the list on the strength of a message nobody received');
  check('  …and no channel was recorded either', attempt.body.channel === null, String(attempt.body.channel));
  check('the refusal was still WRITTEN DOWN',
    (await prisma.notificationLog.count({ where: { group_id: ZZ, subject_id: veh.id, status: 'skipped' } })) === 1,
    'every send path writes a row; a refusal is a record, not a silence');

  console.log('\n— which words, decided by the band —');
  check('the expired wording is chosen by the server from the car, not by the client',
    /motBand\(/.test(readFileSync('pages/api/marketing-send.ts', 'utf8')),
    'a client posting the wrong flag must not be able to tell a road-legal customer they are not');
  const dueCar = await post({ vehicleId: veh.id, channels: ['sms'] });
  check('  …and this car, due in future, gets the due template', dueCar.body.template === 'mot_due', dueCar.body.template);
  await prisma.vehicle.update({ where: { id: veh.id }, data: { mot_expiry: new Date('2026-07-01T00:00:00.000Z') } });
  const expCar = await post({ vehicleId: veh.id, channels: ['sms'] });
  check('  …and the same car, expired, gets the expired one', expCar.body.template === 'mot_expired', expCar.body.template);

  console.log('\n— whose car, and what may be sent —');
  check('no channel is a 400', (await post({ vehicleId: veh.id, channels: [] })).status === 400);
  const other = await prisma.vehicle.findFirst({ where: { group_id: { not: ZZ } }, select: { id: true } });
  check('another garage’s car is a 404', (await post({ vehicleId: other.id, channels: ['sms'] })).status === 404);
  await prisma.vehicle.update({ where: { id: veh.id }, data: { mot_expiry: null } });
  const noDate = await post({ vehicleId: veh.id, channels: ['sms'] });
  check('a car with no MOT date cannot be reminded about one', noDate.status === 400 && /check with DVSA/i.test(noDate.body.message ?? ''),
    'a reminder whose whole content is a date cannot invent "soon"');

  console.log('\n— the channel qualifies the state, it is not a new one —');
  const src = readFileSync('pages/admin/marketing.tsx', 'utf8');
  check('there are still four states', /contacted: 'Contacted', booked: 'Booked', declined: 'Declined', snoozed: 'Snoozed'/.test(src)
    && !/texted:/i.test(src), 'a texted car is a contacted car');
  check('  …and the channel reads as a suffix', /by text and email/.test(src));
  check('the page no longer claims nothing sends', !/Nothing here sends/.test(src),
    'it does now, one row at a time');
  check('and what this gate cannot prove is said out loud',
    /No SMS or email provider is configured locally/.test(prose(readFileSync('scripts/marketing-send-gate.mjs', 'utf8'))));
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    // BY THE FIXTURE'S OWN REGISTRATIONS, never an id the code handed back.
    const mine = await prisma.vehicle.findMany({ where: { group_id: ZZ, registration: { in: [REG, 'ZZ76NOO'] } }, select: { id: true } });
    const vids = [...new Set([fix.veh, ...mine.map((v) => v.id)])];
    // NotificationLog rows are NOT deleted by cascade and are a record of a real refusal against a
    // fixture — removed here because the fixture goes, and AuditLog is left alone as always.
    await step('notifications', () => prisma.notificationLog.deleteMany({ where: { group_id: ZZ, subject_id: { in: vids } } }));
    await step('threads', () => prisma.messageThread.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: vids } } }));
    await step('contacts', () => prisma.marketingContact.deleteMany({ where: { group_id: ZZ, vehicle_id: { in: vids } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: vids } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vids } } }));
    await step('customers', () => prisma.customer.deleteMany({ where: { group_id: ZZ, name: CUST } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [REG, 'ZZ76NOO'] } } })) === 0
      && (await prisma.customer.count({ where: { group_id: ZZ, name: CUST } })) === 0
      && (await prisma.notificationLog.count({ where: { group_id: ZZ, subject_id: { in: vids } } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
