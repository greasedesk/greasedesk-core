/**
 * File: scripts/lookup-reset-gate.mjs
 * A LOOKUP'S ANSWER BELONGS TO THE REGISTRATION IT CAME FROM.
 * @gate-requires: server:3000, db
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────────────────────────
 * Type a wrong plate, press Look up, notice the mistake, correct the plate, press Look up again —
 * and the form still holds the FIRST car's make, model, colour, year, fuel and engine size, plus
 * its owner's name, phone and email on the two forms that fill them. The merge is fill-blanks-only,
 * so once a field is populated the second lookup cannot replace it. Saving writes the wrong car's
 * identity onto the right car's record.
 *
 * The rule was correct for the case it was written for — pressing Look up twice on the SAME car,
 * where clobbering a manual correction would be wrong. It was never extended to the case where the
 * registration itself changed, which is not a re-fetch: it is a different vehicle.
 *
 * ── THE RULE THIS HOLDS ─────────────────────────────────────────────────────────────────────────
 * A lookup records WHAT it filled and WHICH plate it came from. When the plate changes, a field is
 * cleared if it STILL HOLDS what the lookup wrote; a value the operator has since changed is theirs
 * and survives. Clearing everything would be worse than the bug on the details pane, where those
 * fields are seeded from the car's saved record — correcting a typo would blank a real car.
 *
 * The one residual error is a value the operator typed that happens to equal what the lookup wrote.
 * That costs a retype. Keeping another car's data is silent and reaches the database. The asymmetry
 * is the whole argument: when in doubt, clear.
 *
 * ── AND TWO THINGS THE FORM CANNOT FIX ──────────────────────────────────────────────────────────
 * - /api/dvsa-lookup writes the looked-up car's MOT MILEAGE HISTORY onto whatever `vehicleId` the
 *   caller names, guarded only by tenant ownership. That is a database write at LOOKUP time, before
 *   any Save, which no amount of form-clearing undoes.
 * - /api/jobcard stamps mot_checked_at by INFERRING a lookup from the MOT fields merely arriving,
 *   so another car's MOT dates arrive stamped as verified. The client must say which plate they
 *   came from; absent, nothing is stamped and the fields are dropped.
 *
 * ── WHAT THE ODOMETER SECTION DOES NOT PROVE, STATED HERE ───────────────────────────────────────
 * The guard is proven against its PURE PREDICATE and against the endpoint's structure, not by
 * making DVSA return a history for a fixture. No synthetic registration can do that, and reaching
 * it would mean committing a real customer's plate to this file to query a live API. That trade is
 * worse than the stated limit. Same discipline as proving a destructive gate against the pure rule.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
// Tolerant: absent before this slice lands, so the run reaches all its checks instead of dying at 1.
const L = await import('../lib/vehicle-lookup-client.ts').catch(() => ({}));
const ID = await import('../lib/vehicle-identity.ts').catch(() => ({}));
const D = await import('../lib/dvsa.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
// TWO CARS THAT SHARE NOTHING. Every assertion below names a value unique to one of them, so a
// check can never pass because the two happen to agree.
const A = { reg: 'ZZ07LKA', make: 'Talbot', model: 'Horizon', colour: 'Ochre', vin: 'ZZVINAAAAAAAAAA01', owner: 'Marchetti Lookup Fixture', phone: '07700 900801' };
const B = { reg: 'ZZ07LKB', make: 'Autobianchi', model: 'Bianchina', colour: 'Teal', vin: 'ZZVINBBBBBBBBBB02', owner: 'Vasquez Lookup Fixture', phone: '07700 900802' };

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
/** Comments stripped: a rule named in prose is not a rule applied in code. */
const prose = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
let fix = null, browser = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: { in: [A.owner, B.owner] } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. THE RULE, AS PURE FUNCTIONS ───────────────────────────────────────────────────────────
  console.log('\n— the rule —');
  check('lib/vehicle-lookup-client exports the three',
    ['applyLookup', 'staleAgainst', 'clearStale'].every((f) => typeof L[f] === 'function'),
    ['applyLookup', 'staleAgainst', 'clearStale'].map((f) => `${f}=${typeof L[f]}`).join(' '));
  check('one predicate decides whether two plates are the same car',
    typeof ID.sameRegistration === 'function',
    'the form, the odometer guard and the MOT stamp must not each have their own idea of it');

  const call = (f, ...a) => { try { return L[f](...a); } catch { return null; } };
  const filled = call('applyLookup',
    { make: '', model: 'Kept By Hand', colour: '', year: '' },
    { make: A.make, model: B.model, colour: A.colour, year: '1979' }, ' zz07 lka ');
  check('a blank field is filled', filled?.values?.make === A.make, String(filled?.values?.make));
  check('  …and one the operator typed is not clobbered', filled?.values?.model === 'Kept By Hand',
    String(filled?.values?.model));
  check('  …and the fill records ONLY what it actually wrote',
    !!filled && !('model' in (filled.fill?.fields ?? { model: 1 })) && filled.fill?.fields?.make === A.make,
    JSON.stringify(filled?.fill?.fields ?? null));
  check('  …against the NORMALISED plate', filled?.fill?.reg === 'ZZ07LKA', String(filled?.fill?.reg));

  check('the same plate typed untidily is not a change',
    call('staleAgainst', filled?.fill, ' zz07 lka ') === false,
    'a stray space must not wipe the form');
  check('  …and a different plate is', call('staleAgainst', filled?.fill, B.reg) === true);
  check('  …and with nothing filled there is nothing to be stale',
    call('staleAgainst', null, B.reg) === false);

  const edited = { make: A.make, model: 'Kept By Hand', colour: 'Operator Repainted', year: '1979' };
  const cleared = call('clearStale', edited, filled?.fill);
  check('a field still holding the lookup’s value is cleared', cleared?.values?.make === '',
    JSON.stringify(cleared?.values?.make));
  // THE CASE THAT DECIDES THE DESIGN.
  check('  …a field the operator CHANGED survives', cleared?.values?.colour === 'Operator Repainted',
    `${JSON.stringify(cleared?.values?.colour)} — a changed value is provably theirs`);
  check('  …a field the lookup never wrote is untouched', cleared?.values?.model === 'Kept By Hand',
    'the details pane seeds these from the saved car; clearing them would blank a real vehicle');
  check('  …and it reports what it cleared', Array.isArray(cleared?.cleared) && cleared.cleared.includes('make')
    && !cleared.cleared.includes('colour'), JSON.stringify(cleared?.cleared));

  const withMot = call('applyLookup', { make: '' }, { make: A.make }, A.reg, { mot: true });
  check('MOT is cleared unconditionally — it has no manual input',
    call('clearStale', { make: A.make }, withMot?.fill)?.clearMot === true);
  check('  …and a fill that carried none does not claim to clear it',
    call('clearStale', { make: A.make }, filled?.fill)?.clearMot === false);

  // ── 2. THE THREE FORMS USE IT, AND THE THREE OLD COPIES ARE GONE ─────────────────────────────
  console.log('\n— one rule, three call sites, no survivors —');
  const FORMS = ['components/jobcard/CustomerDetailsForm.tsx', 'pages/admin/jobcards/new.tsx', 'pages/admin/diary.tsx'];
  const src = Object.fromEntries(FORMS.map((f) => [f, prose(readFileSync(f, 'utf8'))]));
  const notApplying = FORMS.filter((f) => !/applyLookup\(/.test(src[f]));
  check('all three apply the shared merge', notApplying.length === 0, notApplying.join(', ') || '3 of 3');
  const notClearing = FORMS.filter((f) => !/clearStale\(/.test(src[f]));
  check('  …and all three clear on a plate change', notClearing.length === 0, notClearing.join(', ') || '3 of 3');
  // THE HAND-ROLLED MERGE, matched by its SHAPE rather than by a word prose could contain.
  const handRolled = FORMS.filter((f) => /!\w+\.trim\(\)\s*&&\s*r\.vehicle\./.test(src[f]) || /keep\(p\.\w+,\s*r\./.test(src[f]));
  check('  …and no hand-rolled fill-blanks-only is left', handRolled.length === 0,
    handRolled.join(', ') || 'the duplication went with the rule');

  // ── 3. THE ODOMETER GUARD ────────────────────────────────────────────────────────────────────
  console.log('\n— a lookup for one car must not write to another —');
  check('sameRegistration matches the same plate typed differently',
    ID.sameRegistration?.(' zz07 lka ', 'ZZ07LKA') === true);
  check('  …refuses two different plates', ID.sameRegistration?.(A.reg, B.reg) === false);
  // FAIL CLOSED: absent is refused, never waved through.
  check('  …and refuses an absent one rather than assuming a match',
    ID.sameRegistration?.(null, A.reg) === false && ID.sameRegistration?.(A.reg, '') === false,
    'a missing plate is not a matching plate');
  const dvsaSrc = prose(readFileSync('pages/api/dvsa-lookup.ts', 'utf8'));
  check('the endpoint reads the vehicle’s own plate before writing to it',
    /registration:\s*true/.test(dvsaSrc),
    'it selected only { id: true }, so it could not compare');
  check('  …and the odometer write is behind the match', /sameRegistration\(/.test(dvsaSrc));

  // ── 4. THE MOT STAMP CANNOT BE INFERRED ──────────────────────────────────────────────────────
  console.log('\n— and a stamp says which plate was asked about —');
  check('lib/dvsa decides the stamp from the two plates', typeof D.motClientWrite === 'function',
    'the server cannot otherwise tell whose MOT it was handed');
  const now = new Date('2026-09-05T09:00:00.000Z');
  const incoming = { motExpiry: '2027-04-01', lastMotMileage: 41000, lastMotDate: '2026-04-01' };
  const safe = (...a) => { try { return D.motClientWrite(...a); } catch { return undefined; } };
  const matched = safe({}, incoming, A.reg, ' zz07 lka ', now);
  check('a matching plate stamps', matched?.mot_checked_at?.getTime?.() === now.getTime(), JSON.stringify(matched ?? null));
  const mismatched = safe({}, incoming, B.reg, A.reg, now);
  check('  …a different plate writes NOTHING AT ALL', mismatched === null,
    `${JSON.stringify(mismatched)} — not merely an unstamped write: another car's MOT date is not this car's data`);
  const absent = safe({}, incoming, null, A.reg, now);
  check('  …and an absent source is refused, not assumed', absent === null, JSON.stringify(absent));
  // THE LIMIT THIS CLOSES, and the reason the flag is worth its wire byte.
  const noFacts = safe({}, { motExpiry: null, lastMotMileage: null, lastMotDate: null }, A.reg, A.reg, now);
  check('  …while "asked, and this car has no MOT yet" can finally be recorded',
    noFacts?.mot_checked_at?.getTime?.() === now.getTime(),
    'it was indistinguishable from "nobody asked" — jobcard.ts called that unfixable server-side');
  const cardSrc = prose(readFileSync('pages/api/jobcard.ts', 'utf8'));
  check('the create path no longer infers a lookup from arriving fields',
    /motClientWrite\(/.test(cardSrc) && !/motLookupAnswered/.test(cardSrc), 'motLookupAnswered is gone');

  // ── 5. THE FIXTURES ──────────────────────────────────────────────────────────────────────────
  const site = await zzSite(prisma);
  const mk = async (c) => {
    const cust = await prisma.customer.create({ data: { group_id: ZZ, name: c.owner, phone: c.phone }, select: { id: true } });
    const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: c.reg, registration_normalized: c.reg,
      make: c.make, model: c.model, colour: c.colour, vin: c.vin, vin_normalized: c.vin }, select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
    return { cust: cust.id, veh: veh.id };
  };
  fix = { a: await mk(A), b: await mk(B) };

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const post = (pg, url, body) => pg.evaluate(async ([u, b]) => {
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [url, body]);
  const val = async (tid) => { const l = page.locator(`[data-testid="${tid}"]`); return (await l.count()) ? (await l.inputValue()) : ' MISSING'; };
  const setReg = async (tid, v) => { const l = page.locator(`[data-testid="${tid}"]`); await l.fill(''); await l.type(v, { delay: 15 }); };

  // ── 6. NEW JOB CARD — the form that also carries the owner ───────────────────────────────────
  console.log('\n— new job card —');
  await page.goto(`${BASE}/admin/jobcards/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="new-reg"]', { timeout: 30000 }).catch(() => {});
  await setReg('new-reg', A.reg);
  await page.locator('[data-testid="veh-lookup"]').click();
  await page.waitForTimeout(2500);
  // POSITIVE FIRST: everything after this is meaningless if the lookup never filled anything.
  check('the wrong plate fills the form', (await val('new-make')) === A.make, await val('new-make'));
  check('  …and its owner', (await val('new-customer')) === A.owner, await val('new-customer'));
  await setReg('new-reg', B.reg);
  await page.waitForTimeout(600);
  check('correcting the plate clears the car', (await val('new-make')) === '', JSON.stringify(await val('new-make')));
  check('  …and the owner with it', (await val('new-customer')) === '' && (await val('new-phone')) === '',
    `${JSON.stringify(await val('new-customer'))} / ${JSON.stringify(await val('new-phone'))} — that phone number is where SMS goes`);
  await page.locator('[data-testid="veh-lookup"]').click();
  await page.waitForTimeout(2500);
  check('  …and the second lookup fills the RIGHT car', (await val('new-make')) === B.make, await val('new-make'));
  check('  …with nothing of the first left anywhere',
    !(await page.evaluate(([a, o]) => document.body.innerHTML.includes(a) || document.body.innerHTML.includes(o), [A.make, A.owner]))
    && (await val('new-customer')) === B.owner,
    'paired with a positive: a blank page satisfies "the first car is absent"');

  // ── 7. DIARY QUICK-CREATE — same rule, the booking entry point ───────────────────────────────
  console.log('\n— diary quick-create —');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${BASE}/admin/diary?site=${site.id}&view=day`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const opener = page.locator('[data-testid="diary-new-job"]');
  check('the booking form is reachable the way a user reaches it', (await opener.count()) === 1, `${await opener.count()} openers`);
  if (await opener.count()) { await opener.click(); await page.waitForTimeout(800); }
  await setReg('create-reg', A.reg);
  await page.locator('[data-testid="veh-lookup"]').click();
  await page.waitForTimeout(2500);
  check('the wrong plate fills the booking', (await val('create-make')) === A.make, await val('create-make'));
  check('  …and its owner', (await val('create-customer')) === A.owner, await val('create-customer'));
  await setReg('create-reg', B.reg);
  await page.waitForTimeout(600);
  check('correcting the plate clears both', (await val('create-make')) === '' && (await val('create-customer')) === '',
    `${JSON.stringify(await val('create-make'))} / ${JSON.stringify(await val('create-customer'))}`);
  await page.locator('[data-testid="veh-lookup"]').click();
  await page.waitForTimeout(2500);
  check('  …and the right car arrives', (await val('create-make')) === B.make && (await val('create-customer')) === B.owner,
    `${await val('create-make')} / ${await val('create-customer')}`);

  // ── 8. CUSTOMER DETAILS — DVSA only, so the answer is served to it ───────────────────────────
  // ROUTED, and the reason is stated: this pane asks DVSA and nothing else, and no fixture plate
  // can make a live API answer. Routing proves THE FORM'S MERGE, which is where the bug is; the
  // fetch path itself is covered by sections 6 and 7 against real records.
  console.log('\n— customer details (DVSA answer served to the form) —');
  await page.setViewportSize({ width: 1280, height: 900 });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: fix.a.cust, vehicle_id: fix.a.veh, status: 'draft', odometer_in: 12000 },
    select: { id: true } });
  fix.card = card.id;
  await ctx.route('**/api/dvsa-lookup**', async (route) => {
    const reg = new URL(route.request().url()).searchParams.get('reg') ?? '';
    const car = reg === B.reg ? B : A;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ found: true, make: car.make, model: car.model, colour: car.colour, fuel: 'Petrol', engineCc: 1200,
        motExpiry: reg === B.reg ? '2027-02-02' : '2027-01-01', lastMotMileage: 1000, lastMotDate: '2026-01-01' }) });
  });
  await page.goto(`${BASE}/admin/jobcards/${card.id}?tab=details`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="veh-make"]', { timeout: 30000 }).catch(() => {});
  // The fixture car HAS a make, so a lookup cannot fill it — blank it first, which is the real
  // shape of the case this pane exists for: a returning car created without DVSA.
  await page.locator('[data-testid="veh-make"]').fill('');
  await page.locator('[data-testid="veh-model"]').fill('');
  await setReg('veh-reg', A.reg);
  await page.locator('[data-testid="veh-lookup"]').click();
  await page.waitForTimeout(1500);
  check('the wrong plate fills the blanks', (await val('veh-make')) === A.make, await val('veh-make'));
  await setReg('veh-reg', B.reg);
  await page.waitForTimeout(600);
  check('correcting the plate clears them', (await val('veh-make')) === '', JSON.stringify(await val('veh-make')));
  await page.locator('[data-testid="veh-lookup"]').click();
  await page.waitForTimeout(1500);
  check('  …and the right car fills them', (await val('veh-make')) === B.make && (await val('veh-model')) === B.model,
    `${await val('veh-make')} ${await val('veh-model')}`);
  // ── 9. THE CREATE ENDPOINT REFUSES IT, NOT JUST THE PURE FUNCTION ────────────────────────────
  // Sections 4 proves motClientWrite decides correctly and that jobcard.ts NAMES it. Neither proves
  // the endpoint behaves — a gate that only reads source cannot tell a call from a mention. So the
  // card is created the way the form creates one, and the row is read back.
  console.log('\n— and the create endpoint refuses an unattributable MOT —');
  const MOT_FACTS = { motExpiry: '2027-06-01', lastMotMileage: 55000, lastMotDate: '2026-06-01' };
  const mkCard = async (reg, sourceReg, who) => {
    const r = await post(page, '/api/jobcard', {
      registration: reg, customerName: who, phone: '07700 900803', mileage: 10000,
      siteId: site.id, ...MOT_FACTS, ...(sourceReg ? { motSourceReg: sourceReg } : {}),
    });
    return r;
  };
  const wrongSource = await mkCard('ZZ07LKC', B.reg, 'Mismatch Lookup Fixture');
  check('the card is created', wrongSource.status === 200 || wrongSource.status === 201,
    `HTTP ${wrongSource.status} ${JSON.stringify(wrongSource.body).slice(0, 140)}`);
  const wrongVeh = await prisma.vehicle.findFirst({ where: { group_id: ZZ, registration: 'ZZ07LKC' },
    select: { id: true, mot_expiry: true, last_mot_date: true, last_mot_mileage: true, mot_checked_at: true } });
  fix.mismatch = wrongVeh?.id ?? null;
  check('  …and an MOT from another plate is not stamped', wrongVeh?.mot_checked_at === null,
    String(wrongVeh?.mot_checked_at));
  check('  …nor written at all', wrongVeh?.mot_expiry === null && wrongVeh?.last_mot_date === null && wrongVeh?.last_mot_mileage === null,
    `${wrongVeh?.mot_expiry} / ${wrongVeh?.last_mot_date} / ${wrongVeh?.last_mot_mileage}`);
  // THE POSITIVE HALF: the two checks above are satisfied by an endpoint that writes no MOT ever.
  const rightSource = await mkCard('ZZ07LKD', 'zz07 lkd', 'Matched Lookup Fixture');
  check('a matching plate does write it', rightSource.status === 200 || rightSource.status === 201,
    `HTTP ${rightSource.status}`);
  const rightVeh = await prisma.vehicle.findFirst({ where: { group_id: ZZ, registration: 'ZZ07LKD' },
    select: { id: true, mot_expiry: true, mot_checked_at: true } });
  fix.matched = rightVeh?.id ?? null;
  check('  …and stamps it', !!rightVeh?.mot_checked_at && !!rightVeh?.mot_expiry,
    `${rightVeh?.mot_expiry} stamped ${rightVeh?.mot_checked_at}`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    if (fix.card) await step('card', () => prisma.jobCard.deleteMany({ where: { id: fix.card } }));
    for (const vid of [fix.mismatch, fix.matched].filter(Boolean)) {
      await step('created cards', () => prisma.jobCard.deleteMany({ where: { vehicle_id: vid } }));
      await step('created edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: vid } }));
      await step('created odometer', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: vid } }));
      await step('created vehicle', () => prisma.vehicle.deleteMany({ where: { id: vid } }));
    }
    await step('created customers', () => prisma.customer.deleteMany({
      where: { group_id: ZZ, name: { in: ['Mismatch Lookup Fixture', 'Matched Lookup Fixture'] } } }));
    for (const f of [fix.a, fix.b].filter(Boolean)) {
      await step('odometer', () => prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: f.veh } }));
      await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: f.veh } }));
      await step('vehicle', () => prisma.vehicle.deleteMany({ where: { id: f.veh } }));
      await step('customer', () => prisma.customer.deleteMany({ where: { id: f.cust } }));
    }
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.customer.count({ where: { group_id: ZZ, name: { in: [A.owner, B.owner, 'Mismatch Lookup Fixture', 'Matched Lookup Fixture'] } } })) === 0
      && (await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [A.reg, B.reg, 'ZZ07LKC', 'ZZ07LKD'] } } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
