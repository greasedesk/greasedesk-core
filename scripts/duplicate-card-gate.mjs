// @gate-timeout: 180
/**
 * File: scripts/duplicate-card-gate.mjs
 * THE SECOND CARD FOR A CAR THAT ALREADY HAS ONE.
 *
 * LX13ZPO carried two open cards for four days. A booking form that takes a registration and never
 * asks whether that registration is already on the board created the second one, and the diary
 * showed both — different lifts, different afternoons, nothing saying they were the same MINI. Every
 * photo, video, reading and finding sat on the first; the second held a £50 MOT line and nothing.
 *
 * ── WHAT "OPEN" MEANS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────────────
 * The question is "is there a live conversation or a live job for this car", NOT "does this customer
 * owe us money". `invoiced` is excluded on purpose: the work is finished, the bay is free, and
 * refuseBayWrite already treats a frozen invoice as the point a card stops accepting work. A car
 * back next month is a new visit. `no_show` is excluded for a stronger reason — rebooking someone
 * who did not turn up is the most likely legitimate second card there is, and warning on it would
 * teach people to click through the warning in the case that matters.
 *
 * ── WHY A PURE HALF AND A SERVED HALF ───────────────────────────────────────────────────────────
 * The status filter is asserted end-to-end, because that is where a wrong list does its damage. The
 * invoice flag is asserted against the PURE shaper instead: proving it end-to-end would mean
 * fabricating an Invoice row on a live tenant to be read once, and a read-only branch takes a stub
 * over a mutated real row every time.
 *
 * ── @gate-timeout: 180 — MEASURED, NOT GUESSED ─────────────────────────────────────────────────
 * 14.3s warm on 2026-08-23: three cars, eight cards, a browser launch, four lookups and a form
 * driven at phone width. 180s is twelve times that, covering a cold first compile and other browser
 * gates competing for cores, and it sits BELOW the 300s default because a browser gate that stops
 * responding should be killed in three minutes rather than five.
 *
 * NOTE FOR ANYONE RED-PROVING THIS: patching a page component makes the next run race Next's
 * rebuild, and the abort lands on the LOGIN fill with a bare timeout — nothing to do with the
 * assertion under test. Hit /admin/login once and re-run; the second attempt fails by name.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. LX13ZPO is not touched.
 */
import './_gate-preflight.mjs';
const { zzSite } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('playwright-core');
const { JOB_STATUSES } = await import('../lib/jobcard-status.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

let D = null;
try { D = await import('../lib/duplicate-cards.ts'); } catch { /* named below */ }

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'Duplicate Card Fixture Holder';
const REGS = ['ZZ76DUP', 'ZZ76CLS', 'ZZ76TWO'];
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null, browser = null;

try {
  // ── 1. THE RULE, PURE ────────────────────────────────────────────────────────────────────────
  console.log('\n— what counts as open —');
  check('lib/duplicate-cards exists', D !== null, 'the pure half of the rule');
  if (D) {
    check('exactly draft, quoted, accepted, in_progress',
      JSON.stringify([...D.OPEN_FOR_DUPLICATE].sort()) === JSON.stringify(['accepted', 'draft', 'in_progress', 'quoted']),
      [...D.OPEN_FOR_DUPLICATE].join(', '));
    for (const s of ['invoiced', 'paid', 'done', 'declined', 'cancelled', 'no_show']) {
      check(`  …and NOT ${s}`, !D.OPEN_FOR_DUPLICATE.includes(s),
        s === 'no_show' ? 'rebooking a no-show is the most legitimate second card there is'
          : s === 'invoiced' ? 'the work is finished and the bay is free — that is credit control, not duplication' : '');
    }
    // TOTALITY: the compile-time rail. A bare array would silently opt out of it.
    check('it goes through statusSubset, so a new status cannot default in',
      /OPEN_FOR_DUPLICATE[^=]*=\s*statusSubset\(\{/.test(readFileSync('lib/duplicate-cards.ts', 'utf8')),
      'a bare array compiles fine when a status is added, and that is the whole failure mode');
    check('  …and status-union-gate knows about it',
      /'OPEN_FOR_DUPLICATE'/.test(readFileSync('scripts/status-union-gate.mjs', 'utf8')),
      'the subset-discipline list is hand-maintained; a set missing from it is unguarded');

    // ── THE INVOICE FLAG, against the shaper rather than a fabricated row ──────────────────────
    const base = { id: 'c1', created_at: new Date('2026-08-21T16:15:00Z'), status: 'draft',
                   start_at: new Date('2026-08-21T16:15:00Z'), resource: { name: 'Lift 1' } };
    check('the shaper reports an invoice when there is one',
      D.openCardSummary({ ...base, invoice: { id: 'i1' } }).hasInvoice === true);
    check('  …and reports none when there is not', D.openCardSummary({ ...base, invoice: null }).hasInvoice === false);
    check('  …carrying the date, the status and the lift',
      (() => { const s = D.openCardSummary({ ...base, invoice: null });
        return s.status === 'draft' && s.lift === 'Lift 1' && s.bookedFor === '2026-08-21'; })(),
      JSON.stringify(D.openCardSummary({ ...base, invoice: null })));
    check('  …and says so honestly when the card is not booked at all',
      D.openCardSummary({ ...base, start_at: null, resource: null, invoice: null }).lift === null,
      'an unbooked card is still a duplicate — it just has no slot to name');
  }

  // ── 2. THE ENDPOINT ──────────────────────────────────────────────────────────────────────────
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: REGS } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  const site = await zzSite(prisma);
  const resource = await prisma.resource.findFirst({ where: { site_id: site.id }, select: { id: true, name: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST }, select: { id: true } });
  fix = { cust: cust.id, vehs: [], cards: [] };

  const mkCar = async (reg) => {
    const v = await prisma.vehicle.create({ data: { group_id: ZZ, registration: reg,
      registration_normalized: reg, make: 'Dup', model: 'Fixture' }, select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: cust.id, is_current: true } });
    fix.vehs.push(v.id);
    return v.id;
  };
  const mkCard = async (vehId, status, booked) => {
    const c = await prisma.jobCard.create({ data: {
      group_id: ZZ, site_id: site.id, vehicle_id: vehId, customer_id: cust.id, status,
      ...(booked && resource ? { resource_id: resource.id, start_at: new Date('2026-08-21T16:15:00Z'),
        end_at: new Date('2026-08-21T17:15:00Z'), booking_duration_minutes: 60 } : {}),
    }, select: { id: true } });
    fix.cards.push(c.id);
    return c.id;
  };

  const A = await mkCar(REGS[0]); await mkCard(A, 'in_progress', true);
  const B = await mkCar(REGS[1]);
  for (const s of ['invoiced', 'paid', 'done', 'cancelled', 'no_show']) await mkCard(B, s, true);
  const C = await mkCar(REGS[2]); await mkCard(C, 'draft', true); await mkCard(C, 'accepted', true);

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const look = (reg) => page.evaluate(async (r) => {
    const res = await fetch(`/api/vehicle-lookup?reg=${encodeURIComponent(r)}`, { cache: 'no-store' });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, reg);

  console.log('\n— what the lookup returns —');
  const rA = await look('ZZ76DUP');
  check('a car with an in_progress card returns it', Array.isArray(rA.body.openCards) && rA.body.openCards.length === 1,
    JSON.stringify(rA.body.openCards ?? rA.body).slice(0, 140));
  check('  …carrying its status and lift', rA.body.openCards?.[0]?.status === 'in_progress'
    && rA.body.openCards?.[0]?.lift === resource?.name, JSON.stringify(rA.body.openCards?.[0]));
  check('  …and whether an invoice exists', rA.body.openCards?.[0]?.hasInvoice === false,
    'the field must be present and boolean, not absent');

  const rB = await look('ZZ76CLS');
  check('invoiced, paid, done, cancelled and no_show return NONE',
    Array.isArray(rB.body.openCards) && rB.body.openCards.length === 0,
    `${rB.body.openCards?.length ?? 'absent'} of 5 closed cards came back`);
  check('  …and the fixture really did have five cards to ignore',
    (await prisma.jobCard.count({ where: { vehicle_id: fix.vehs[1] } })) === 5,
    'a check that passes because nothing exists is not a check');

  const rC = await look('ZZ76TWO');
  check('two open cards return BOTH', rC.body.openCards?.length === 2,
    JSON.stringify((rC.body.openCards ?? []).map((c) => c.status)));

  // ── 3. THE WARNING, ON THE DIARY FORM ────────────────────────────────────────────────────────
  // Driven through the real control: the lookup is an explicit button press, never auto-fire.
  console.log('\n— the warning, where somebody books —');
  // AT PHONE WIDTH, because that is where this control exists. "+ Add booking" is mobile-only
  // (diary.tsx says so); the desktop entry is a grid gesture into the SAME CreateDialog via the
  // SAME setCreate — the source states that, and the dialog under test is one component either way.
  // Driving the real button a real user presses beats reaching past it to the state it sets.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${BASE}/admin/diary?site=${site.id}&view=day&date=2026-08-21`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const opener = page.locator('[data-testid="diary-new-job"]');
  check('the "new job" control is reachable', (await opener.count()) === 1, `${await opener.count()} openers`);
  if (await opener.count()) { await opener.click(); await page.waitForTimeout(800); }
  const regBox = page.locator('[data-testid="create-reg"]');
  check('the create form is reachable', (await regBox.count()) === 1, `${await regBox.count()} reg inputs`);
  if ((await regBox.count()) === 1) {
    await regBox.fill('ZZ76TWO');
    await page.locator('[data-testid="veh-lookup"]').click();
    await page.waitForTimeout(2500);
    const warn = page.locator('[data-testid="duplicate-warning"]');
    check('the warning appears after the lookup', (await warn.count()) === 1, `${await warn.count()} warnings`);
    if (await warn.count()) {
      const txt = (await warn.innerText()).replace(/\s+/g, ' ');
      check('  …naming the state and the lift', /draft|accepted/i.test(txt) && new RegExp(resource.name, 'i').test(txt), txt.slice(0, 160));
      check('  …and when', /21 Aug|2026-08-21|21\/08/.test(txt), txt.slice(0, 160));
      check('  …offering to open the existing card',
        (await page.locator('[data-testid="duplicate-open-0"]').count()) === 1);
      // FILL THE REST FIRST, or this proves nothing: the submit is disabled on an incomplete form
      // for reasons that have nothing to do with the warning. A complete form that still submits
      // WITH a duplicate on screen is the actual claim.
      await page.locator('[data-testid="create-customer"]').fill('Duplicate Card Fixture Holder');
      await page.locator('[data-testid="create-time"]').fill('09:00');
      await page.locator('[data-testid="create-lift"]').selectOption(resource.id);
      await page.waitForTimeout(500);
      check('  …while NEVER blocking the booking',
        !(await page.locator('[data-testid="create-submit"]').isDisabled()),
        'a garage genuinely does sometimes want a second card');
    }
    // A car with no open card must produce NO warning — the discriminating half.
    await regBox.fill('ZZ76CLS');
    await page.locator('[data-testid="veh-lookup"]').click();
    await page.waitForTimeout(2500);
    check('a car whose cards are all closed gets no warning',
      (await page.locator('[data-testid="duplicate-warning"]').count()) === 0,
      'five closed cards is not a duplicate');
  }

  // ── 4. NOTHING IS SEEDED, AND NOTHING IS STORED ──────────────────────────────────────────────
  console.log('\n— client-only, and no capture form seeded —');
  const src = readFileSync('pages/admin/diary.tsx', 'utf8');
  check('the warning is not persisted anywhere',
    !/duplicate[A-Za-z]*Dismiss|localStorage\.setItem\('gd-duplicate/.test(src),
    'a dismissal that outlives the form would be a fact about the data, and that is a stored decision');
  const pane = readFileSync('lib/jobcard-page-data.ts', 'utf8');
  check('the tyre capture form still seeds from THIS card only',
    /tyreReading\.findMany\(\{\s*\n?\s*where: \{ group_id: groupId, job_card_id: cardId \}/.test(pane),
    'seeding from the vehicle would stamp another visit\'s figures as measured today');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 900)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 110)}`); } };
    await step('cards', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, id: { in: fix.cards } } }));
    await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: fix.vehs } } }));
    await step('vehicles', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: { in: REGS } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, id: fix.cust } }));
    const left = await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: REGS } } })
      + await prisma.customer.count({ where: { group_id: ZZ, id: fix.cust } })
      + await prisma.jobCard.count({ where: { group_id: ZZ, id: { in: fix.cards } } });
    check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
