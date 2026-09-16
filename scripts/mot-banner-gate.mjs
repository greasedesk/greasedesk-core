/**
 * File: scripts/mot-banner-gate.mjs
 * @gate-requires: db, server
 *
 * THE MOT BANNER — one predicate, two surfaces, and the date it is read against.
 *
 * ── THE CASE THAT CAUSED IT ─────────────────────────────────────────────────────────────────────
 * A car booked in for next week whose MOT expires the day before it arrives. Judged against TODAY it
 * is fine and no banner appears; judged against the day it is COMING it cannot legally be driven
 * here. So the clauses below do not merely check that a banner renders — they check that moving the
 * BOOKING moves the verdict, and that the banner says which day it used. A banner a reader takes for
 * "today" when it means "next Tuesday" is worse than no banner.
 *
 * ── THE THREE ABSENCES, WHICH ARE NOT ONE SILENCE ───────────────────────────────────────────────
 * Measured on the tenant this was built for: 256 cars with a verified expiry, 12 where DVSA answered
 * and there are NO tests (all 2023-25), 6 typed but never verified, 2 nobody has ever asked about.
 * Those last three are different facts with different remedies, and the gate proves the predicate
 * separates them — because the failure mode is all three collapsing into no banner at all, which a
 * person reads as "the MOT is fine".
 *
 * FIXTURES ON ZZ ONLY, prefix ZZMOT, swept before and after.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const { hasKey } = await import('/Users/hugh/Developer/greasedesk-core/lib/anchored-match.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZMOT';

const MB = await import('/Users/hugh/Developer/greasedesk-core/lib/mot-banner.ts');
const { motBanner, againstLabel, MOT_SOON_DAYS } = MB;

const NOW = new Date('2026-09-16T10:00:00.000Z');
const day = (n) => new Date(NOW.getTime() + n * 86_400_000);
const iso = (d) => d.toISOString().slice(0, 10);
const BOOK_DAY = new Date(new Date('2026-09-16T10:00:00.000Z').getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
const src = (f) => readFileSync(`/Users/hugh/Developer/greasedesk-core/${f}`, 'utf8');

let prisma;
let browser = null;
try {
  console.log('— THE FIVE STATES ARE REACHABLE AND DISTINCT —');
  const checked = NOW.toISOString();
  const states = {
    expired: motBanner({ motExpiry: iso(day(-3)), motCheckedAt: checked }, NOW),
    due_soon: motBanner({ motExpiry: iso(day(10)), motCheckedAt: checked }, NOW),
    // DVSA answered, no tests, and the car is new enough that this is expected.
    probably_new: motBanner({ motExpiry: null, motCheckedAt: checked, year: 2025 }, NOW),
    // DVSA answered, no tests, and the car is far too old for that to be innocent.
    unknown: motBanner({ motExpiry: null, motCheckedAt: checked, year: 2011 }, NOW),
    // Nobody has ever asked. NOT the same fact as either of the two above.
    never: motBanner({ motExpiry: null, motCheckedAt: null, year: 2011 }, NOW),
    fine: motBanner({ motExpiry: iso(day(200)), motCheckedAt: checked }, NOW),
  };
  check('an expired MOT is `expired`', states.expired.kind === 'expired', states.expired.kind);
  check('one inside four weeks is `due_soon`', states.due_soon.kind === 'due_soon', states.due_soon.kind);
  check('DVSA answered with no tests on a 2025 car is `no_mot_probably_new`',
    states.probably_new.kind === 'no_mot_probably_new', states.probably_new.kind);
  check('DVSA answered with no tests on a 2011 car is `no_mot_unknown`',
    states.unknown.kind === 'no_mot_unknown', states.unknown.kind);
  check('nobody having asked is `never_checked`', states.never.kind === 'never_checked', states.never.kind);
  check('a car with eight months left gets NO banner', states.fine.kind === 'none', states.fine.kind);
  const kinds = new Set(Object.values(states).map((s) => s.kind));
  check('  …and all six outcomes are genuinely different', kinds.size === 6, [...kinds].join(', '));

  /**
   * THE ONE THAT MATTERS MOST. `never_checked` and `no_mot_unknown` differ by a SINGLE field, and
   * collapsing them is the easy mistake: both have no expiry, and both would render the same words
   * if the predicate only looked at mot_expiry. One means "we asked and there are no tests"; the
   * other means "nobody has ever asked". The second is the only one where a button is the answer.
   */
  check('the two empty-expiry states are told apart by mot_checked_at ALONE',
    states.unknown.kind !== states.never.kind,
    'same expiry (null), same year — only the provenance differs, and it must decide the words');

  console.log('\n— READ AGAINST THE BOOKING, NOT TODAY: THE CASE THAT CAUSED THIS —');
  /**
   * Expires in 40 days. Today that is comfortably outside the window and there is no banner at all.
   * The car is booked in 20 days, so on the day it ARRIVES the MOT has 20 days left — inside the
   * window. The whole feature is this clause.
   */
  const far = { motExpiry: iso(day(40)), motCheckedAt: checked };
  const today40 = motBanner(far, NOW);
  const booked40 = motBanner(far, NOW, day(20).toISOString());
  check('a 40-day MOT is silent when judged against today', today40.kind === 'none', today40.kind);
  check('  …and WARNS when judged against a booking 20 days out', booked40.kind === 'due_soon',
    `${booked40.kind} — this is the case that bit the garage`);
  check('  …and says the booking is what it used', booked40.against === 'booking',
    `against=${booked40.against}`);
  check('  …with the days counted from the BOOKING, not from today',
    booked40.kind === 'due_soon' && booked40.days === 20, `days=${booked40.days} (40 from today)`);

  const soon = { motExpiry: iso(day(10)), motCheckedAt: checked };
  const bookedPast = motBanner(soon, NOW, day(20).toISOString());
  check('an MOT expiring before the booking reads as EXPIRED, not merely due',
    bookedPast.kind === 'expired', `${bookedPast.kind} — on the day it arrives it is already out`);

  const backdated = motBanner(far, NOW, day(-5).toISOString());
  check('a booking in the PAST is not the question being asked, so it reads against today',
    backdated.kind === 'none' && today40.kind === 'none',
    'writing a card up after the visit must not be judged against a day that has gone');
  const stillToday = motBanner(soon, NOW, day(-5).toISOString());
  check('  …and that fallback still says `today`, never `booking`', stillToday.against === 'today',
    `against=${stillToday.against}`);

  console.log('\n— THE BANNER SAYS WHICH DAY IT USED —');
  const lblB = againstLabel(booked40), lblT = againstLabel(stillToday);
  check('the booking-judged label names the booking date', lblB.includes(iso(day(20))), lblB);
  check('  …and explicitly says it is NOT today', /not today/i.test(lblB), lblB);
  check('the today-judged label says today and names no other date', /today/i.test(lblT) && !/\d{4}-\d{2}-\d{2}/.test(lblT), lblT);
  check('  …and the two labels cannot be mistaken for each other', lblB !== lblT);

  console.log('\n— THE FOUR-WEEK BOUNDARY —');
  const onBoundary = motBanner({ motExpiry: iso(day(MOT_SOON_DAYS)), motCheckedAt: checked }, NOW);
  const pastBoundary = motBanner({ motExpiry: iso(day(MOT_SOON_DAYS + 1)), motCheckedAt: checked }, NOW);
  check(`exactly ${MOT_SOON_DAYS} days out is inside the window`, onBoundary.kind === 'due_soon', onBoundary.kind);
  check(`  …and ${MOT_SOON_DAYS + 1} days out is not`, pastBoundary.kind === 'none', pastBoundary.kind);
  const today0 = motBanner({ motExpiry: iso(NOW), motCheckedAt: checked }, NOW);
  check('expiring TODAY is due, not yet expired', today0.kind === 'due_soon' && today0.days === 0, today0.kind);

  console.log('\n— "PROBABLY NEW" IS A CLAIM, AND IT IS MADE HONESTLY —');
  const exact = motBanner({ motExpiry: null, motCheckedAt: checked, firstRegistered: iso(day(-400)) }, NOW);
  check('with a first-registration date the first MOT due date is STATED',
    exact.kind === 'no_mot_probably_new' && exact.reason.includes(iso(new Date(Date.UTC(
      day(-400).getUTCFullYear() + 3, day(-400).getUTCMonth(), day(-400).getUTCDate())))),
    exact.reason);
  const yearOnly = motBanner({ motExpiry: null, motCheckedAt: checked, year: 2025 }, NOW);
  /**
   * A YEAR IS NOT A DATE. A January 2023 car was due its first MOT in January 2026 and a December
   * 2023 car is not due until December. With only the year the sentence must not pretend otherwise.
   */
  check('with only a YEAR the wording is hedged and names no due date',
    yearOnly.reason.includes('may not be due') && !/\d{4}-\d{2}-\d{2}/.test(yearOnly.reason), yearOnly.reason);
  const oldNoMot = motBanner({ motExpiry: null, motCheckedAt: checked, firstRegistered: '2019-04-01' }, NOW);
  check('a 2019 car with no MOT is NOT excused as new', oldNoMot.kind === 'no_mot_unknown', oldNoMot.reason);

  console.log('\n— ONE PREDICATE, NOT TWO —');
  const card = src('components/jobcard/CustomerDetailsForm.tsx');
  const diary = src('pages/admin/diary.tsx');
  const banner = src('components/MotBanner.tsx');
  check('the card form renders the shared banner', card.includes('<MotBanner'));
  check('the diary create form renders the same one', diary.includes('<MotBanner'));
  check('the banner is the only thing that calls the predicate',
    banner.includes('motBanner(') && !card.includes('motBanner(') && !diary.includes('motBanner('),
    'two surfaces computing their own answer is how they drift apart');
  /**
   * THE THRESHOLD LIVES IN ONE PLACE. A surface that hardcodes 28 stays right until the number moves,
   * and then disagrees with the other one silently.
   */
  check('  …and neither surface carries its own four-week number',
    !/\b28\b/.test(card) && !/\bMOT_SOON_DAYS\b/.test(card) && !/\bMOT_SOON_DAYS\b/.test(diary));

  /**
   * OUR OWN RECORD IS NOT A VERIFICATION. storedMot exists so a returning car can be warned about at
   * all; sending it back on save would stamp mot_checked_at, which means DVSA ANSWERED.
   */
  const createBody = diary.slice(diary.indexOf('async function createJob'), diary.indexOf('async function addNote'));
  check('the diary never writes its own stored MOT back as if DVSA had answered',
    !hasKey(createBody, 'storedMot'),
    'mot_checked_at means DVSA answered — reading our record and stamping it would be a lie in a column');

  prisma = await gatePrisma();
  const sweep = async () => {
    const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
    const ids = vs.map((v) => v.id);
    if (!ids.length) return 0;
    // Job cards first: JobCard.vehicle is onDelete NoAction, so one stray card makes the vehicle
    // delete throw P2003 and abandon the rest of the teardown.
    await prisma.jobCard.deleteMany({ where: { group_id: ZZ_GROUP, vehicle_id: { in: ids } } });
    return (await prisma.vehicle.deleteMany({ where: { id: { in: ids } } })).count;
  };
  const beforeN = await sweep();
  if (beforeN) console.log(`\n  (swept ${beforeN} fixture vehicle(s) left by an earlier run)`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const cust = await prisma.customer.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  // A card is only a BOOKING when it holds a slot (lib/jobcard-status::isBookedCard: resource AND
  // start AND end). Without the resource this fixture is a card with dates on it and the page would
  // rightly judge against today — which is the very silence under test, so the fixture must be real.
  const resource = await prisma.resource.findFirst({ where: { site_id: site.id }, select: { id: true } });
  const mk = async (reg, v) => prisma.vehicle.create({
    data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'ZZ', model: 'Gate', ...v },
    select: { id: true },
  });
  // Expires in 40 days — SILENT today, and the card below is booked 20 days out.
  const vFar = await mk(`${PREFIX}FAR`, { mot_expiry: day(40), mot_checked_at: NOW, year: 2018 });
  // Nobody has ever asked about this one.
  const vNever = await mk(`${PREFIX}NEW`, { mot_expiry: null, mot_checked_at: null, year: 2011 });
  // Already out. Warns on any surface, with or without a slot picked.
  const vExp = await mk(`${PREFIX}EXP`, { mot_expiry: day(-9), mot_checked_at: NOW, year: 2016 });

  const bookedCard = await prisma.jobCard.create({
    data: {
      group_id: ZZ_GROUP, site_id: site.id, customer_id: cust?.id ?? null, vehicle_id: vFar.id, status: 'accepted',
      resource_id: resource?.id ?? null,
      start_at: day(20), end_at: new Date(day(20).getTime() + 7_200_000), booking_duration_minutes: 120,
    }, select: { id: true },
  });
  check('the fixture card really holds a slot, so "against the booking" is being tested',
    !!resource?.id, resource?.id ? 'resource attached' : 'NO RESOURCE — the card would read against today');
  const neverCard = await prisma.jobCard.create({
    data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: cust?.id ?? null, vehicle_id: vNever.id, status: 'draft' },
    select: { id: true },
  });

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  console.log('\n— ON THE JOB CARD, AGAINST ITS OWN BOOKING —');
  await page.goto(`${origin}/admin/jobcards/${bookedCard.id}?tab=details`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="veh-reg"]', { timeout: 25000 });
  const live = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="mot-banner"]');
    const reg = document.querySelector('[data-testid="veh-reg"]');
    return {
      exists: !!b,
      state: b?.getAttribute('data-mot-state') ?? null,
      text: b?.textContent ?? '',
      top: b ? Math.round(b.getBoundingClientRect().top) : null,
      regTop: reg ? Math.round(reg.getBoundingClientRect().top) : null,
      h: b ? Math.round(b.getBoundingClientRect().height) : 0,
      visible: !!(b && b.offsetParent !== null),
      viewportH: window.innerHeight,
    };
  });
  check('the card whose MOT is 40 days out STILL warns, because it is booked in 20',
    live.exists && live.state === 'due_soon',
    `state=${live.state} — today this car is fine, and that is exactly the silence being fixed`);
  check('  …the banner is painted, not merely in the DOM', live.visible && live.h > 0,
    `height=${live.h}, offsetParent ${live.visible ? 'set' : 'null'}`);
  check('  …and IN THE VIEWPORT at the top of the form, above the registration field',
    live.top !== null && live.top >= 0 && live.top < live.viewportH && live.regTop !== null && live.top < live.regTop,
    `banner y=${live.top}, registration y=${live.regTop}, viewport ${live.viewportH}`);
  check('  …and it names the booking date it judged against, not "today"',
    live.text.includes(iso(day(20))) && /not today/i.test(live.text),
    live.text.replace(/\s+/g, ' ').slice(0, 160));

  console.log('\n— THE NEVER-CHECKED CAR IS OFFERED A LOOKUP, NOT A SENTENCE —');
  await page.goto(`${origin}/admin/jobcards/${neverCard.id}?tab=details`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="veh-reg"]', { timeout: 25000 });
  const never = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="mot-banner"]');
    const btn = document.querySelector('[data-testid="mot-banner-lookup"]');
    return {
      state: b?.getAttribute('data-mot-state') ?? null,
      text: b?.textContent ?? '',
      hasButton: !!btn, btnEnabled: btn ? !btn.disabled : false,
      btnVisible: !!(btn && btn.offsetParent !== null && btn.getBoundingClientRect().height > 0),
    };
  });
  check('a car nobody has looked up shows the never-checked banner', never.state === 'never_checked', `${never.state}`);
  check('  …and OFFERS THE LOOKUP — a button, not better wording', never.hasButton && never.btnVisible && never.btnEnabled,
    `button ${never.hasButton ? 'present' : 'ABSENT'}, visible=${never.btnVisible}, enabled=${never.btnEnabled}`);
  check('  …and never implies the MOT is in order', !/\bfine\b|\bvalid\b|\bin order\b/i.test(never.text),
    never.text.replace(/\s+/g, ' ').slice(0, 140));

  console.log('\n— ON THE DIARY CREATE FORM, THE SAME BANNER —');
  // The blank-booking button is MOBILE-ONLY (the desktop path is a gesture on the grid), so reach it
  // the way the person using it does rather than inventing a shortcut into the dialog.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/admin/diary`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="diary-new-job"]', { state: 'visible', timeout: 25000 });
  await page.click('[data-testid="diary-new-job"]');
  await page.waitForSelector('[data-testid="create-reg"]', { timeout: 15000 });
  const blank = await page.$('[data-testid="mot-banner"]');
  check('with no plate typed there is no banner, because there is no car to judge', !blank,
    'a claim about an empty field would be a claim about nothing');

  /**
   * A RETURNING CAR used to arrive at this form with NOTHING about its MOT — the records branch of
   * the lookup returned `mot: null` — so the surface where the booking is actually agreed could not
   * warn about the cars it knows best.
   */
  /**
   * WAIT ON THE LOOKUP, NOT ON THE BANNER. The never-checked banner is already on screen the moment a
   * plate is typed, so waiting for `[data-testid=mot-banner]` returns instantly and reads the form
   * MID-FLIGHT — which is how this clause first went red against correct code. The button re-enables
   * only when lookBusy clears, and that is a signal about the lookup rather than about the answer.
   */
  const lookupIdle = () => page.waitForFunction(
    () => { const b = document.querySelector('[data-testid="veh-lookup"]'); return !!b && !b.disabled; },
    null, { timeout: 25000 },
  ).catch(() => {}); // a timeout must leave the CLAUSE to fail, not end the gate
  await page.fill('[data-testid="create-reg"]', `${PREFIX}EXP`);
  await page.click('[data-testid="veh-lookup"]');
  await lookupIdle();
  const diaExp = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="mot-banner"]');
    return { state: b?.getAttribute('data-mot-state') ?? null, text: b?.textContent ?? '' };
  });
  check('a returning car brings its stored MOT to the booking form', diaExp.state === 'expired',
    `state=${diaExp.state} — a records hit used to carry no MOT at all`);
  check('  …and with no slot picked yet it says it judged against today',
    /today/i.test(diaExp.text) && !/not today/i.test(diaExp.text),
    diaExp.text.replace(/\s+/g, ' ').slice(0, 140));

  /**
   * THE WHOLE FEATURE, LIVE, ON THE SURFACE WHERE THE SLOT IS AGREED: the same car is silent until a
   * date is chosen, and warns the moment the chosen day is one its MOT does not reach.
   */
  await page.fill('[data-testid="create-reg"]', `${PREFIX}FAR`);
  await page.click('[data-testid="veh-lookup"]');
  await lookupIdle();
  const diaNoSlot = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="mot-banner"]');
    return b?.getAttribute('data-mot-state') ?? null;
  });
  check('a 40-day MOT is silent on the booking form before a day is chosen', diaNoSlot === null,
    `state=${diaNoSlot}`);
  await page.fill('[data-testid="create-date"]', BOOK_DAY);
  await page.fill('[data-testid="create-time"]', '09:00');
  await page.waitForFunction(() => !!document.querySelector('[data-testid="mot-banner"]'), null, { timeout: 10000 }).catch(() => {});
  const diaSlot = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="mot-banner"]');
    return { state: b?.getAttribute('data-mot-state') ?? null, text: b?.textContent ?? '' };
  });
  check('  …and CHOOSING a day 20 days out makes the same car warn', diaSlot.state === 'due_soon',
    `state=${diaSlot.state} — nothing about the car changed, only the day it is coming`);
  check('  …naming the chosen day, not today', diaSlot.text.includes(BOOK_DAY) && /not today/i.test(diaSlot.text),
    diaSlot.text.replace(/\s+/g, ' ').slice(0, 160));
  check('  …and it is the same predicate: this car reads the same way as on its job card',
    diaSlot.state === live.state, `diary=${diaSlot.state}, card=${live.state}`);

  console.log('\n— AND NOT ON THE DIARY BLOCK —');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/admin/diary?date=${BOOK_DAY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const onGrid = await page.$$('[data-testid="mot-banner"]');
  check('the day grid carries no banners', onGrid.length === 0,
    `${onGrid.length} — a row of flags on cars already here is noise at the one moment nobody can act`);
  const dd = src('lib/diary-day.ts');
  check('  …and the block query does not even fetch the MOT', !hasKey(dd, 'mot_expiry') && !hasKey(dd, 'mot_checked_at'));

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      if (ids.length) {
        await prisma.jobCard.deleteMany({ where: { group_id: ZZ_GROUP, vehicle_id: { in: ids } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      }
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      check('teardown left ZZ with none of this gate’s vehicles', left === 0, `${ids.length} removed, ${left} left`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
