/**
 * File: scripts/invoice-advisory-gate.mjs
 * @gate-requires: db, server
 *
 * OVERDUE AND NEARLY-DUE INVOICES, IN RED — and nothing else in red.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * The list could not colour anything before this slice: GET /api/invoices never selected
 * `due_date`, so every row arrived without the one column the advisory is about. A source scan
 * would not have caught that and did not — so the deciding clauses here DRIVE THE REAL PAGE and
 * read the rendered colour, not the class name.
 *
 * THE THRESHOLD IS A JUDGEMENT WITH ONE HOME. NEAR_DUE_DAYS lives in lib/account-terms beside
 * dueDateFor and overdueWhere, and the boundary clauses read the constant rather than the number 7
 * — pin the rule, not the figure that may legitimately move.
 *
 * THE THREE EXCLUSIONS ARE THE POINT. Retail work has no deadline (the car is not released until
 * it is paid for), warranty settles at £0, a historical record was settled in another system, and
 * an imported invoice IS chargeable and DOES carry a due date from the mint — so only an explicit
 * exclusion keeps years of collected trade out of a chasing colour. Each is planted here, and the
 * set that DOES get an advisory is compared against IS_DEBT, which is also what the `overdue` TAB
 * filters on: a row painted red that the tab then refuses to show would be two rules disagreeing
 * in front of the person chasing the money.
 *
 * Fixtures on ZZ Gate Garage only, prefix ZZDUE, swept before and after. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, zzSite, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const AT = await import(`${R}/lib/account-terms.ts`);
const SCOPE = await import(`${R}/lib/invoice-series-scope.ts`);
const LF = await import(`${R}/lib/invoice-list-filters.ts`);
const PREFIX = 'ZZDUE';
const DAY = 86_400_000;
const NOW = new Date('2026-10-01T12:00:00Z');
const at = (ms) => new Date(NOW.getTime() + ms);
/** A chargeable, issued invoice — the only shape that can be chased. Each clause varies ONE field. */
const debt = (over) => ({ status: 'issued', series: 'chargeable', is_imported: false, due_date: at(-over) });
/**
 * THE RENDERED FIXTURES ARE DATED FROM THE REAL CLOCK. The page computes the advisory against the
 * server's own `new Date()`, so a fixture dated from the fixed NOW above decays: mot-banner-gate
 * went red a fortnight after it was written because its "40 days out" car had quietly become a
 * 25-day car. The hour of slack keeps each count off its own boundary whatever time of day it is.
 */
const REAL = new Date();
const realAt = (ms) => new Date(REAL.getTime() + ms);

let prisma = null;
let browser = null;
let fix = null;
try {
  prisma = await gatePrisma();

  // ── THE THRESHOLD HAS ONE HOME ────────────────────────────────────────────────────────────────
  console.log('— one number, in one place —');
  const terms = readFileSync(`${R}/lib/account-terms.ts`, 'utf8');
  const homes = [`${R}/lib/account-terms.ts`, `${R}/pages/api/invoices.ts`, `${R}/pages/admin/invoices/index.tsx`, `${R}/lib/invoice-list-filters.ts`]
    .filter((f) => /NEAR_DUE_DAYS\s*=/.test(readFileSync(f, 'utf8')));
  check('NEAR_DUE_DAYS is DECLARED once, in lib/account-terms', homes.length === 1 && homes[0].endsWith('lib/account-terms.ts'), homes.join(', '));
  check('  …named as a judgement, with the rejected alternative recorded',
    /a fifth of the term/.test(terms) && /without doing arithmetic/.test(terms),
    'the scaling version was considered and declined — the reason has to outlive the conversation');
  const page = readFileSync(`${R}/pages/admin/invoices/index.tsx`, 'utf8');
  // THE RENDERER'S OWN BODY, not the whole file: the page subtracts a day elsewhere to print a
  // period banner, and a file-wide arithmetic scan would fail on that and say nothing about this.
  const dueLine = page.slice(page.indexOf('function DueLine'), page.indexOf('export default function InvoicesPage'));
  check('the DueLine renderer exists and renders the SERVER\'s kind', dueLine.length > 0 && /due\.kind === 'overdue'/.test(dueLine));
  check('  …and cannot read the clock, so it cannot hold a threshold',
    !/NEAR_DUE_DAYS/.test(dueLine) && !/Date|86_?400_?000|864e5/.test(dueLine),
    'a renderer with no clock has nowhere to put a second copy of the rule');

  // ── THE BOUNDARY IS THE CONSTANT ──────────────────────────────────────────────────────────────
  console.log('\n— the boundary reads the constant, not the figure —');
  const N = AT.NEAR_DUE_DAYS;
  check(`exactly ${N} days ahead is near-due`, AT.dueAdvisory(debt(-N * DAY), NOW)?.kind === 'near_due', JSON.stringify(AT.dueAdvisory(debt(-N * DAY), NOW)));
  check('  …a minute further out is nothing at all', AT.dueAdvisory(debt(-(N * DAY + 60_000)), NOW) === null);
  check('  …and one day inside still is', AT.dueAdvisory(debt(-(N - 1) * DAY), NOW)?.kind === 'near_due');

  // ── THE THREE EXCLUSIONS ──────────────────────────────────────────────────────────────────────
  console.log('\n— what is never chased —');
  check('RETAIL, with no deadline at all → nothing', AT.dueAdvisory({ ...debt(14 * DAY), due_date: null }, NOW) === null,
    'an unpaid retail invoice is a car still in the yard, not a debtor');
  check('WARRANTY, settled at £0 → nothing', AT.dueAdvisory({ ...debt(14 * DAY), series: 'warranty' }, NOW) === null);
  check('HISTORICAL, settled in another system → nothing', AT.dueAdvisory({ ...debt(14 * DAY), series: 'historical' }, NOW) === null);
  check('IMPORTED and chargeable and past its date → nothing', AT.dueAdvisory({ ...debt(14 * DAY), is_imported: true }, NOW) === null,
    'these ARE chargeable and DO carry a due date — only the explicit exclusion keeps them out');
  check('  …the overdue TAB excludes imported in the same breath', LF.listWhere('overdue', null).where.is_imported === false,
    JSON.stringify(LF.listWhere('overdue', null).where));
  check('a CAR SALE not yet paid for IS a debt and is chased', AT.dueAdvisory({ ...debt(14 * DAY), series: 'vehicle_sale' }, NOW)?.kind === 'overdue');
  const chased = ['chargeable', 'warranty', 'historical', 'vehicle_sale'].filter((s) => AT.dueAdvisory({ ...debt(14 * DAY), series: s }, NOW) !== null);
  check('the series that get an advisory ARE IS_DEBT — one rule, not two lists',
    JSON.stringify(chased.slice().sort()) === JSON.stringify(SCOPE.seriesIncluded(SCOPE.IS_DEBT).slice().sort()),
    `${chased.join(', ')} vs ${SCOPE.seriesIncluded(SCOPE.IS_DEBT).join(', ')}`);
  check('an UNRECOGNISED series gets no advisory rather than a guessed one',
    AT.dueAdvisory({ ...debt(14 * DAY), series: 'subscription' }, NOW) === null);
  for (const st of ['paid', 'paid_pending', 'void', 'settled']) {
    check(`status ${st} → nothing, however old the date`, AT.dueAdvisory({ ...debt(400 * DAY), status: st }, NOW) === null);
  }

  // ── THE DAY COUNTS ────────────────────────────────────────────────────────────────────────────
  console.log('\n— the counts a person reads —');
  check('14 days past → overdue 14', JSON.stringify(AT.dueAdvisory(debt(14 * DAY), NOW)) === '{"kind":"overdue","days":14}');
  check('TWENTY HOURS past → overdue 0, which the page says as plain "overdue"',
    JSON.stringify(AT.dueAdvisory(debt(20 * 3600_000), NOW)) === '{"kind":"overdue","days":0}',
    'past the deadline the count FLOORS: rounding would call this a full day late, and "0 days overdue" is not a sentence');
  check('three days ahead → due in 3', JSON.stringify(AT.dueAdvisory(debt(-3 * DAY), NOW)) === '{"kind":"near_due","days":3}');
  check('23 hours ahead → due in 1, never "today"', JSON.stringify(AT.dueAdvisory(debt(-23 * 3600_000), NOW)) === '{"kind":"near_due","days":1}',
    'ahead of the deadline the count ceilings, so a day still to run never reads as the day it expires');
  const words = JSON.parse(readFileSync(`${R}/public/locales/en-GB/invoices.json`, 'utf8')).due;
  check('both sentences exist, singular and plural, and the sub-day case saying only "overdue"',
    words.overdue_one === '{{count}} day overdue' && words.overdue_other === '{{count}} days overdue'
    && words.nearDue_one === 'due in {{count}} day' && words.nearDue_other === 'due in {{count}} days'
    && words.overdueNoDays === 'overdue', JSON.stringify(words));

  // ── ON THE REAL PAGE ──────────────────────────────────────────────────────────────────────────
  console.log('\n— on screen, on ZZ —');
  const site = await zzSite(prisma);
  const sweep = async () => {
    const cards = await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } });
    await prisma.invoice.deleteMany({ where: { job_card_id: { in: cards.map((c) => c.id) } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
    await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
  };
  await sweep();
  const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Fleet Ltd`, account_terms_days: 30 }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}1`, registration_normalized: `${PREFIX}1` }, select: { id: true } });
  fix = { custId: cust.id, vehId: veh.id };
  let seq = 90_000;
  // Minted directly: the subject under test is a READ, and three real mints would spend three
  // numbers from the live gapless series on a tenant that will never send these.
  const mk = async (label, dueInDays, extra = {}) => {
    const card = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'invoiced' }, select: { id: true } });
    await prisma.invoice.create({
      data: {
        group_id: ZZ_GROUP, site_id: site.id, job_card_id: card.id, status: 'issued', series: 'chargeable',
        sequence_value: ++seq, invoice_number: `${PREFIX}-${seq}`, issued_at: realAt(-60 * DAY),
        customer_name_snapshot: `${PREFIX} Fleet Ltd`, vehicle_reg_snapshot: `${PREFIX}1`,
        company_name_snapshot: 'ZZ Gate Garage', vat_registered_at_issue: true,
        due_date: realAt(dueInDays * DAY - 3600_000), ...extra,
      },
    });
    return label;
  };
  await mk('late', -14);          // 14 days past its date
  await mk('soon', 3);            // due in 3 days
  await mk('imported', -200, { is_imported: true, external_ref: `${PREFIX}-XERO-1` });
  await mk('retail', 0, { due_date: null });

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const pg = await ctx.newPage();
  /**
   * ── THE RACE, FORCED ────────────────────────────────────────────────────────────────────────
   * The list is searched with a debounce, so two loads overlap on every query, and without a
   * request token the SLOWER one wins. This gate found it by accident: on a warm server the
   * unfiltered first load resolved AFTER the filtered one and overwrote it — 28 rows on screen
   * with a query in the box — while on a cold server the compile made the first request arrive
   * first and the race was invisible. A defect that only appears on a quick machine is one the
   * owner meets and the gate does not.
   *
   * So the unfiltered load is HELD BACK deliberately. Nothing about the product is stubbed: the
   * real request goes out and the real answer comes back, two and a half seconds late.
   */
  // NO HAND-ROLLED PATH OR QUERY REGEX: this runs INSIDE the page, where lib/anchored-match cannot
  // be imported, so the route is matched as exact text and the query is read with URLSearchParams —
  // which is what the suite's anchoring rule is asking for either way.
  await pg.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const url = String(args[0] ?? '');
      const res = await orig(...args);
      // @anchored-ok: a path PREFIX matched inside the PAGE, where lib/anchored-match cannot be imported — the text is the literal request URL '/api/invoices?', not a property name looked up by key, and the query is read with URLSearchParams rather than matched at all
      const unfiltered = url.includes('/api/invoices?')
        && new URL(url, window.location.origin).searchParams.get('q') === '';
      if (unfiltered) await new Promise((r) => setTimeout(r, 2500));
      return res;
    };
  });
  await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
  await pg.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);
  await pg.goto(`${origin}/admin/invoices?q=${encodeURIComponent(`${PREFIX} Fleet`)}`, { waitUntil: 'domcontentloaded' });
  await pg.fill('input[placeholder*="Search"]', `${PREFIX} Fleet`);
  // The search is debounced, so wait for the list to SETTLE on the fixture set rather than for a
  // minimum — "at least four" was satisfied instantly by the twenty-eight rows already on screen.
  // 45s, not 25: the first load after an edit compiles the page, and a compile ate the settle
  // twice during red-proving — reported as "28 rows", which looks like a filter defect and is not.
  await pg.waitForFunction(() => document.querySelectorAll('tbody tr[data-testid="row"]').length === 4, null, { timeout: 45000 }).catch(() => {});
  const seen = await pg.evaluate(() => {
    const danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const toRgb = (hex) => { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; };
    const rows = [...document.querySelectorAll('tbody tr[data-testid="row"]')].map((tr) => {
      const a = tr.querySelector('[data-testid="invoice-due-advisory"]');
      const r = a?.getBoundingClientRect();
      return {
        number: tr.querySelector('td')?.textContent ?? '',
        text: a?.textContent ?? null,
        kind: a?.getAttribute('data-kind') ?? null,
        colour: a ? getComputedStyle(a).color : null,
        painted: !!(r && r.width > 0 && r.height > 0 && a.offsetParent),
      };
    });
    return { rows, dangerRgb: danger.startsWith('#') ? toRgb(danger) : danger };
  });
  const adv = seen.rows.filter((r) => r.text);
  check('the list renders FOUR fixture rows', seen.rows.length === 4, `${seen.rows.length} rows`);
  const late = adv.find((r) => r.kind === 'overdue');
  const soon = adv.find((r) => r.kind === 'near_due');
  check('the late one says how late, in words', late?.text === '14 days overdue', late?.text ?? 'NOT SHOWN');
  check('the one coming up says when, in words', soon?.text === 'due in 3 days', soon?.text ?? 'NOT SHOWN');
  check('both are RED — the resolved token, not a class name', late?.colour === seen.dangerRgb && soon?.colour === seen.dangerRgb,
    `${late?.colour} / ${soon?.colour} vs --danger ${seen.dangerRgb}`);
  check('  …and actually painted: a box with size, inside a laid-out parent', !!late?.painted && !!soon?.painted);
  check('EXACTLY TWO of the four are coloured — imported and retail stay plain', adv.length === 2,
    adv.map((r) => `${r.number}:${r.text}`).join(' | '));
  // …AND THE HELD-BACK UNFILTERED ANSWER MUST NOT LAND ON TOP OF IT. Four rows now, and still
  // four rows after the delayed response has arrived: the newest request is the only one allowed
  // to answer. Without the token this reverts to the whole list while the search box still reads
  // "ZZDUE Fleet".
  await pg.waitForTimeout(3500);
  const after = await pg.evaluate(() => ({
    rows: document.querySelectorAll('tbody tr[data-testid="row"]').length,
    query: document.querySelector('input[placeholder*="Search"]')?.value ?? null,
  }));
  check('a SLOWER unfiltered response cannot overwrite the filtered list it lost to',
    after.rows === 4 && after.query === `${PREFIX} Fleet`,
    `${after.rows} rows with "${after.query}" in the box, 3.5s after the held-back answer returned`);
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (prisma && fix) {
    const cards = await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle_id: fix.vehId }, select: { id: true } });
    await prisma.invoice.deleteMany({ where: { job_card_id: { in: cards.map((c) => c.id) } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    await prisma.customer.delete({ where: { id: fix.custId } }).catch(() => {});
    const left = await prisma.jobCard.count({ where: { vehicle_id: fix.vehId } })
      + await prisma.vehicle.count({ where: { id: fix.vehId } })
      + await prisma.customer.count({ where: { id: fix.custId } });
    check('teardown removed every fixture row (audit rows stay — append-only)', left === 0, `${left} left`);
  }
  if (prisma) await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
