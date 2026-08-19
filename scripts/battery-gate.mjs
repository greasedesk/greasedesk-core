/**
 * File: scripts/battery-gate.mjs
 * THE BATTERY RULES — and specifically the two states that stop a wrong sale.
 *
 * The obvious rule ("health under 50%, sell a battery") is right about the obvious car and wrong
 * about the one that walks in flat. These assertions defend the states that exist to catch that:
 * CHARGING_FAULT and RETEST. If either ever silently collapses into `replace`, this gate is what
 * says so — the failure mode is a plausible advisory, not an error.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const B = await import('../lib/battery.ts');
const { readFileSync } = await import('node:fs');
const D = await import('../lib/due-items.ts');
const prisma = new PrismaClient();

const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = (v, soc, soh, extra = {}) => ({ voltageMv: Math.round(v * 1000), socPct: soc, sohPct: soh, ...extra });
/** The advisory TEXT, or a sentinel. A probe that removes a state makes batteryAdvisory return
 *  null, and reading .description off that aborted the whole run — so the gate reported one
 *  failure and skipped forty. A gate must fail loudly and COMPLETELY, not stop at the first. */
const say = (n, at) => B.batteryAdvisory(n, at)?.description ?? '«no advisory raised»';
/** A fixed clock. The seasonal wording depends on the month, so every assertion names its date. */
const SEPT = new Date('2026-09-15T00:00:00Z');
const JAN = new Date('2026-01-15T00:00:00Z');
const MAY = new Date('2026-05-15T00:00:00Z');

let fix = null, browser = null;

try {
  // ── 1. THE FIVE STATES ───────────────────────────────────────────────────────────────────────
  console.log('\n— three numbers, five states —');
  check('a healthy battery says nothing', B.batteryState(R(12.7, 95, 92)) === 'ok');
  check('a dead cell outranks everything', B.batteryState(R(9.8, 90, 95)) === 'dead_cell',
    '95% health on a battery with a failed cell is a number the tester cannot help producing');
  check('low health on a CHARGED battery is a replacement', B.batteryState(R(12.5, 88, 41)) === 'replace');
  check('middling health on a charged battery is a note, not a sale', B.batteryState(R(12.5, 88, 62)) === 'monitor');

  console.log('\n— the two that stop a wrong sale —');
  check('low charge + HEALTHY battery is a CHARGING FAULT, not a battery',
    B.batteryState(R(12.1, 32, 88)) === 'charging_fault',
    'the fault is upstream of the thing being tested — an alternator or a drain');
  check("the owner's own example refuses to advise a replacement",
    B.batteryState(R(11.98, 0, 17)) === 'retest',
    '11.98V / 0% / 17% is a FLAT battery, and a conductance tester reads low health on one');
  check('  …and it says so in words a customer can act on',
    /cannot be judged until it is charged and retested/.test(say(R(11.98, 0, 17), SEPT)));
  check('  …and never uses the word replace', (() => {
    const t = say(R(11.98, 0, 17), SEPT);
    // The sentinel must not pass this by being silent — an absent advisory is its own failure.
    return t !== '«no advisory raised»' && !/replace/i.test(t);
  })());
  check('the charging-fault advisory says the battery itself is sound',
    /The battery itself is sound/.test(say(R(12.1, 32, 88), SEPT)),
    'the temptation is to sell the part in front of you');

  // ── 2. THE BAND NOBODY NAMES ────────────────────────────────────────────────────────────────
  console.log('\n— the gap between the rules —');
  check('charge 50–59 on a healthy battery falls to ok, not through a crack',
    B.batteryState(R(12.3, 55, 90)) === 'ok' && B.batteryState(R(12.3, 50, 80)) === 'ok');
  check('every state is reachable', new Set(
    [R(12.7, 95, 92), R(9.8, 90, 95), R(12.5, 88, 41), R(12.5, 88, 62), R(12.1, 32, 88), R(11.98, 0, 17)]
      .map(B.batteryState)).size === 6, 'six inputs, six distinct states');

  // ── 3. THE BOUNDARIES, EXACTLY ───────────────────────────────────────────────────────────────
  console.log('\n— on the line, not near it —');
  check('10.50V is NOT a dead cell; 10.49V is',
    B.batteryState(R(10.5, 90, 90)) !== 'dead_cell' && B.batteryState(R(10.499, 90, 90)) === 'dead_cell');
  check('health 50 is a monitor, 49 is a replace',
    B.batteryState(R(12.6, 90, 50)) === 'monitor' && B.batteryState(R(12.6, 90, 49)) === 'replace');
  check('charge 60 trusts the health figure, 59 does not',
    B.batteryState(R(12.4, 60, 40)) === 'replace' && B.batteryState(R(12.4, 59, 40)) === 'retest');

  // ── 4. NONE OF IT IS LAW ─────────────────────────────────────────────────────────────────────
  console.log('\n— the thresholds are the owner’s, unlike 1.6mm —');
  const src = (await import('node:fs')).readFileSync('lib/battery.ts', 'utf8');
  const prose = src.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
  check('the file says plainly that no threshold here is legal',
    /A battery has NO legal threshold at all/i.test(prose),
    'someone will otherwise treat 50% the way they treat 1.6mm');
  check('the constants are exported, so they are editable in one place',
    [B.DEAD_CELL_MV, B.REPLACE_BELOW_SOH, B.MONITOR_BELOW_SOH, B.SOH_TRUSTED_ABOVE_SOC, B.CHARGING_FAULT_BELOW_SOC]
      .every((n) => typeof n === 'number'));
  check('  …and moving one MOVES the rule', (() => {
    // The property, not the number: a battery just above the replace line must fall below it if the
    // line were raised past it. Pinning 50 would break every time the owner changed their mind.
    const justAbove = B.REPLACE_BELOW_SOH + 5;
    return B.batteryState(R(12.6, 90, justAbove)) === 'monitor'
      && B.batteryState(R(12.6, 90, B.REPLACE_BELOW_SOH - 1)) === 'replace';
  })());

  // ── 5. SEASON IN WORDS, NOT A FABRICATED DATE ───────────────────────────────────────────────
  console.log('\n— urgency without inventing a deadline —');
  check('September says before winter', /before winter/.test(B.seasonalUrgency(SEPT)));
  check('January does NOT — the cold is already here', !/before winter/.test(B.seasonalUrgency(JAN)));
  check('May is honest that there is no deadline', /at your convenience/.test(B.seasonalUrgency(MAY)));
  check('the month is passed in, never read from the clock',
    /measuredAt: Date/.test(src) && !/seasonalUrgency\(\)/.test(src),
    'so this is testable at a fixed date');

  // ── 6. THE DECLINE RATE REFUSES BEFORE IT GUESSES ───────────────────────────────────────────
  console.log('\n— one reading cannot say when —');
  check('a single test refuses', B.sohDecline([{ measuredAt: SEPT, sohPct: 60 }]).reason === 'too_few');
  check('two tests a fortnight apart refuse — that is noise, not a trend',
    B.sohDecline([{ measuredAt: new Date('2026-09-01'), sohPct: 60 }, { measuredAt: new Date('2026-09-14'), sohPct: 58 }]).reason === 'no_span');
  check('a battery that GAINED health was replaced, not recovering',
    B.sohDecline([{ measuredAt: new Date('2025-09-01'), sohPct: 40 }, { measuredAt: new Date('2026-09-01'), sohPct: 95 }]).reason === 'gained_health');
  const dec = B.sohDecline([{ measuredAt: new Date('2025-09-01'), sohPct: 84 }, { measuredAt: new Date('2026-09-01'), sohPct: 60 }]);
  check('a year apart gives a real rate', dec.ok && dec.pointsPerMonth > 1.8 && dec.pointsPerMonth < 2.2,
    dec.ok ? `${dec.pointsPerMonth} points/month over ${dec.monthsCovered} months` : dec.reason);
  check('  …and it projects a crossing rather than a slogan',
    B.projectedReplaceDate(60, new Date('2026-09-01'), dec).getUTCFullYear() === 2027);
  check('no rate, no date', B.projectedReplaceDate(60, SEPT, { ok: false, reason: 'too_few' }) === null);
  check('a projection further out than three years is refused',
    B.projectedReplaceDate(95, SEPT, { ok: true, pointsPerMonth: 0.5, from: '', to: '', monthsCovered: 12 }) === null,
    'a straight line through noise is not a forecast');

  // ── 7. THE PRINTED LINE ──────────────────────────────────────────────────────────────────────
  console.log('\n— what freezes onto the invoice —');
  const line = B.printedBatteryLine(R(12.45, 86, 72, { ratedCca: 700, ccaStandard: 'EN' }));
  check('all three numbers print, not just the health', /12\.45V/.test(line) && /86% charge/.test(line) && /72% health/.test(line), line);
  check('  …with the denominator they were measured against', /against 700 CCA EN/.test(line));
  check('an unrecorded rating prints no rating rather than a fake one',
    !/against/.test(B.printedBatteryLine(R(12.45, 86, 72))));
  const block = D.printedDueItemsBlock({ motExpiry: null, items: [], tyreLines: [], batteryLine: line });
  check('the block numbers it like everything else', block === `(1) ${line}`, JSON.stringify(block));
  check('no battery test means no battery line, and null means nothing to print',
    D.printedDueItemsBlock({ motExpiry: null, items: [], tyreLines: [], batteryLine: null }) === null);

  // ── 8. THE WRITER, AGAINST THE DATABASE ──────────────────────────────────────────────────────
  console.log('\n— one writer, on a throwaway car —');
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76BAT', make: 'Battery', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { veh: veh.id, cards: [card.id] };

  const r1 = await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null,
    reading: R(11.98, 0, 17, { ratedCca: 700, ccaStandard: 'EN' }), measuredAt: SEPT,
  }));
  check('the flat battery is recorded as a retest', r1.state === 'retest' && r1.advisory === true);
  let items = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id }, select: { description: true, due_basis: true, due_date: true } });
  check('  …one advisory, on next_service, with NO invented date',
    items.length === 1 && items[0].due_basis === 'next_service' && items[0].due_date === null);
  check('  …and it does not tell the customer to buy a battery',
    items.length === 1 && !/replace/i.test(items[0].description), items[0]?.description ?? 'no advisory row');

  // RETESTING THE SAME VISIT corrects rather than stacks — the unique key doing its job.
  const r2 = await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null,
    reading: R(12.55, 92, 44, { ratedCca: 700, ccaStandard: 'EN' }), measuredAt: SEPT,
  }));
  check('charged and retested, it becomes a real replacement', r2.state === 'replace');
  const readings = await prisma.batteryReading.count({ where: { vehicle_id: veh.id } });
  items = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id }, select: { description: true } });
  check('  …one reading, not two — the visit has one test', readings === 1);
  check('  …and one advisory, corrected in place',
    items.length === 1 && /replace before winter/.test(items[0].description), items[0]?.description ?? 'no advisory row');

  // A CLEAN TEST ON A LATER VISIT closes the open warning rather than leaving it standing.
  const card2 = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix.cards.push(card2.id);
  const r3 = await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card2.id, measuredBy: null,
    reading: R(12.8, 98, 96, { ratedCca: 700, ccaStandard: 'EN' }), measuredAt: new Date('2026-11-15T00:00:00Z'),
  }));
  check('a sound battery raises nothing', r3.advisory === false && r3.state === 'ok');
  const open = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id, closed_at: null } });
  const closed = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: veh.id, closed_at: { not: null } }, select: { closed_reason: true } });
  check('  …and CLOSES the standing warning — the battery was replaced', open === 0 && closed?.closed_reason === 'Retested and sound',
    'leaving it open would print last visit’s warning on the next invoice');

  // ── 8b. A BLANK RATING MUST NOT ERASE A KNOWN ONE ───────────────────────────────────────────
  console.log('\n— the one unrecoverable thing this writer could do —');
  const card3 = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix.cards.push(card3.id);
  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card3.id, measuredBy: null,
    // No rating supplied — a mechanic who left it blank, or a surface that never asked.
    reading: R(12.4, 80, 55), measuredAt: new Date('2026-12-01T00:00:00Z'),
  }));
  const kept = await prisma.batteryReading.findFirst({ where: { job_card_id: card3.id }, select: { rated_cca: true, cca_standard: true } });
  check('a blank rating INHERITS the car’s known one rather than nulling it',
    kept?.rated_cca === 700 && kept?.cca_standard === 'EN',
    'a real capture caught this: the retest blanked a denominator that cannot be retrofitted');
  check('  …and the pair is inherited whole, never half',
    (kept?.rated_cca == null) === (kept?.cca_standard == null));

  // ── 9. THE PAIRED DENOMINATOR, AT THE DATABASE ──────────────────────────────────────────────
  console.log('\n— half a denominator is worse than none —');
  let refused = false;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BatteryReading" (id, group_id, vehicle_id, voltage_mv, soc_pct, soh_pct, rated_cca, cca_standard)
       VALUES ('00000000-0000-4000-8000-0000000000ba', $1, $2, 12500, 90, 80, 700, NULL)`, ZZ, veh.id);
  } catch { refused = true; }
  check('a rating without its standard is refused by the DATABASE, not just the form', refused,
    'EN, SAE and DIN rate the same battery differently — the pair is the unit of meaning');
  // ── 9a. THE FLOOR ON THE DENOMINATOR ─────────────────────────────────────────────────────────
  // From the first real user of this form, who typed 9. It saved — the bounds were 1–3000 — so a
  // rating no car battery has went in silently and the health figure was measured against it.
  console.log('\n— a rating no car battery has —');
  check('the floor is well below the smallest real battery', B.MIN_RATED_CCA === 100,
    'a small motorcycle battery is 100–200 CCA and a city car starts near 300, so this refuses typos and nobody’s work');
  check('  …and the reason it exists is recorded against the number',
    /The first real user of this form typed 9/.test(readFileSync('lib/battery.ts', 'utf8').replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ')),
    'a bound with no story attached is the kind somebody loosens');
  // ── 9b. ON THE SERVED DESKTOP PAGE ───────────────────────────────────────────────────────────
  // The phone form is proven in scripts/phone-capture-timing and the customer report below. This is
  // the third surface, and it was flagged unproven twice before being closed — the pure rules can
  // be perfect while the panel never renders, and reading the JSX proves only that the file has it.
  console.log('\n— the battery form, on the page a service advisor uses —');
  browser = await chromium.launch({ channel: 'chrome' });
  const dPage = await (await browser.newContext()).newPage();
  await dPage.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await dPage.fill('input[type="email"]', 'owner@zzgategarage.test');
  await dPage.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([dPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), dPage.click('button[type="submit"]')]);

  // Its own car: the fixture above has been tested three times already, and the prefill would make
  // "the rating was typed" untestable.
  const dVeh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76DBT', make: 'Desk', model: 'Battery' }, select: { id: true } });
  // stage_details_done, because Intake is GATED behind Details (lib/jobcard-tabs). Fixture setup for
  // a state a real card reaches; the gating has its own gate and is not re-proven here.
  const dCard = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: dVeh.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix.deskVeh = dVeh.id; fix.cards.push(dCard.id);

  await dPage.goto(`${BASE}/admin/jobcards/${dCard.id}`, { waitUntil: 'domcontentloaded' });
  await dPage.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await dPage.waitForSelector('[data-testid="battery-capture"]', { timeout: 25000 });
  check('the battery form renders on the served Intake tab', true);

  // ALL THREE OR NOTHING, on the page rather than in the predicate.
  //
  // ── EVERY STEP STARTS FROM A KNOWN STATE ────────────────────────────────────────────────────
  // The first draft toggled the EN radio off and on to reuse one page load, and the standard is a
  // toggle, so the assertions became order-dependent and reported the opposite of the truth. The
  // typo case now gets its own reload instead, and the API probe runs LAST — it writes a reading,
  // and a written reading PREFILLS the rating on the next load, which would quietly satisfy the
  // very rule the pair test is trying to break.
  check('Save is refused before anything is entered', await dPage.locator('[data-testid="battery-save"]').isDisabled());
  await dPage.fill('[data-testid="battery-voltage"]', '11.98');
  await dPage.fill('[data-testid="battery-soc"]', '0');
  check('  …and still refused with two of the three numbers',
    await dPage.locator('[data-testid="battery-save"]').isDisabled(),
    'a test missing one number would silently change which state it lands in');
  await dPage.fill('[data-testid="battery-soh"]', '17');
  check('  …and allowed on three, because the rating is optional',
    await dPage.locator('[data-testid="battery-save"]').isEnabled(),
    'honest-null: an unrecorded rating is a known gap, not a blocked form');

  // BOTH OR NEITHER, from a clean field.
  await dPage.fill('[data-testid="battery-rated-cca"]', '700');
  check('a rating without its standard is refused before the request',
    await dPage.locator('[data-testid="battery-save"]').isDisabled(),
    'the database refuses it too, but a mechanic should get a disabled button, not a constraint');
  await dPage.locator('[data-testid="battery-std-EN"]').click();
  check('  …and accepted once the pair is complete', await dPage.locator('[data-testid="battery-save"]').isEnabled());

  await dPage.locator('[data-testid="battery-save"]').click();
  await dPage.waitForSelector('[data-testid="battery-saved"]', { timeout: 20000 });
  const saidBack = await dPage.locator('[data-testid="battery-saved"]').innerText();
  check('the mechanic is told what the reading MEANT, not just that it saved',
    /advisory was raised/i.test(saidBack), saidBack);

  const deskRow = await prisma.batteryReading.findFirst({
    where: { job_card_id: dCard.id }, select: { voltage_mv: true, soc_pct: true, soh_pct: true, rated_cca: true, cca_standard: true },
  });
  check('  …and the reading landed as typed', deskRow?.voltage_mv === 11980 && deskRow?.soc_pct === 0 && deskRow?.soh_pct === 17
    && deskRow?.rated_cca === 700 && deskRow?.cca_standard === 'EN', JSON.stringify(deskRow));
  const deskItem = await prisma.vehicleDueItem.findFirst({ where: { vehicle_id: dVeh.id }, select: { description: true, observation_key: true } });
  check('  …raising the RETEST advisory, not a replacement',
    deskItem?.observation_key === 'battery' && !/replace/i.test(deskItem?.description ?? 'replace'),
    deskItem?.description ?? 'no advisory');

  // THE TYPO, ON ITS OWN PAGE LOAD. The button stays off and a hint appears in the field's own
  // place, so nobody has to submit to find out — an error after a tap teaches worse than a line of
  // text before one.
  await dPage.goto(`${BASE}/admin/jobcards/${dCard.id}`, { waitUntil: 'domcontentloaded' });
  await dPage.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await dPage.waitForSelector('[data-testid="battery-capture"]', { timeout: 25000 });
  await dPage.fill('[data-testid="battery-voltage"]', '12.5');
  await dPage.fill('[data-testid="battery-soc"]', '90');
  await dPage.fill('[data-testid="battery-soh"]', '80');
  await dPage.fill('[data-testid="battery-rated-cca"]', '9');
  check('a 9 CCA rating keeps Save switched off', await dPage.locator('[data-testid="battery-save"]').isDisabled(),
    'even though the rating was prefilled correctly a moment ago — typing over it must not slip through');
  check('  …with the hint in the field’s own place, not an error banner',
    /400–800/.test(await dPage.locator('[data-testid="battery-cca-hint"]').innerText()),
    await dPage.locator('[data-testid="battery-cca-hint"]').innerText());

  // THE MESSAGE ITSELF, through an AUTHENTICATED request. The first draft posted anonymously and
  // got 401 — the handler checks the session before the body, which is right (validation behaviour
  // is not something to hand an anonymous caller) and meant the assertion never reached the rule
  // it named. Posted from the logged-in page so the cookies are real.
  const post = (body) => dPage.evaluate(async (b) => {
    const r = await fetch('/api/battery-readings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);

  const bad = await post({ jobCardId: dCard.id, voltage: 12.5, socPct: 90, sohPct: 80, ratedCca: 9, ccaStandard: 'EN' });
  check('9 CCA is refused', bad.status === 400, `${bad.status}: ${bad.body?.message ?? ''}`);
  check('  …and the message HELPS rather than scolds', (() => {
    const m = String(bad.body?.message ?? '');
    return /looks like a typo/.test(m)          // names the likely cause, not the user's error
      && /400 and 800/.test(m)                  // gives a number to aim at
      && /battery label/.test(m)                // says where to find it
      && !/invalid|must be|error/i.test(m);     // and none of the words that read as a telling-off
  })(), bad.body?.message);
  check('  …and it repeats back what was actually typed', /^9 CCA/.test(String(bad.body?.message ?? '')),
    'a dropped digit is the likely cause, so showing the number is how someone sees it');
  const okCca = await post({ jobCardId: dCard.id, voltage: 12.5, socPct: 90, sohPct: 80, ratedCca: 720, ccaStandard: 'EN' });
  check('a real rating goes straight through', okCca.status === 200, `${okCca.status}: ${okCca.body?.message ?? ''}`);
  // That last one wrote a reading; the form assertions below overwrite it on the same card (one
  // test per visit), so the card is left in the state the page put it in, not the probe.

  // ── 10. ON THE SERVED CUSTOMER REPORT ────────────────────────────────────────────────────────
  // The screen a prospect looks at during a demo. Asserted on the PAGE, not on buildIntakeReport's
  // return value: a shape that is right in a function and absent in the markup is a shape nobody
  // sees — and the first version of this section proved exactly that distinction is worth keeping,
  // because the data was perfect while the page showed a "we couldn't find that link" error.
  //
  // Its OWN car, because the report shows the vehicle's LATEST test and the cards above have since
  // moved this one on. A served-page assertion has to control what it is looking at.
  console.log('\n— what the customer actually sees —');
  const rVeh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76RPT', make: 'Report', model: 'Fixture' }, select: { id: true } });
  const rCard = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: rVeh.id, status: 'draft' }, select: { id: true } });
  fix.reportVeh = rVeh.id; fix.cards.push(rCard.id);
  await prisma.$transaction((tx) => B.recordBatteryReading(tx, {
    groupId: ZZ, vehicleId: rVeh.id, jobCardId: rCard.id, measuredBy: null,
    reading: R(12.55, 92, 44, { ratedCca: 700, ccaStandard: 'EN' }), measuredAt: SEPT,
  }));

  const { createMagicLink } = await import('../lib/magic-link.ts');
  // rawToken, not token — the row's `token_hash` is what is stored, and reaching for the wrong
  // field produced a page that rendered a polite error and would have failed silently as a
  // "the battery does not show" bug rather than a "the link was wrong" one.
  const link = await createMagicLink({
    groupId: ZZ, jobCardId: rCard.id, purpose: 'intake_report', recipient: 'gate@example.invalid',
  });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await page.goto(`${BASE}/c/${link.rawToken}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="report-battery"]', { timeout: 30000 });

  const txt = (await page.locator('[data-testid="report-battery"]').innerText()).replace(/\n/g, ' | ');
  check('the battery block renders on the served report', txt.length > 0);
  check('  …with all three numbers, not just the health',
    /44/.test(txt) && /92/.test(txt) && /12\.55/.test(txt), txt);
  check('  …and the advisory in lib/battery’s own words', /replace before winter/i.test(txt));
  check('  …and the denominator it was measured against', /700 CCA EN/.test(txt));
  check('the report still carries NO price anywhere',
    !/£/.test(await page.locator('body').innerText()),
    'a finding has no price when it is recorded, and this screen is why');

} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    // AuditLog is append-only. Its rows for these cards stay, correctly.
    const vehIds = [fix.veh, fix.reportVeh, fix.deskVeh].filter(Boolean);
    await step('link', () => prisma.customerMagicLink.deleteMany({ where: { job_card_id: { in: fix.cards } } }));
    await step('readings', () => prisma.batteryReading.deleteMany({ where: { vehicle_id: { in: vehIds } } }));
    await step('due items', () => prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: { in: vehIds } } }));
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: fix.cards } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: vehIds } } }));
    check('teardown removed every fixture row',
      (await prisma.vehicle.count({ where: { id: { in: vehIds } } })) === 0
      && (await prisma.batteryReading.count({ where: { vehicle_id: { in: vehIds } } })) === 0
      && (await prisma.jobCard.count({ where: { id: { in: fix.cards } } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
