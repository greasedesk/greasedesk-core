/**
 * File: scripts/dashboard-period-copy-gate.mjs
 * @gate-timeout: 240
 * @gate-requires: server:3000, db
 *
 * THE TILES MUST NAME THE PERIOD THEY ARE SHOWING.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
 * Six sub-lines said "this month" whatever period was selected, and the dashboard's DEFAULT
 * selection is `rolling_12`. So the first thing a garage owner saw on opening the page was a
 * twelve-month break-even figure described as "hours to sell this month just to stand still".
 * The number was right and the sentence was wrong, which is the harder kind to notice — nothing
 * looks broken, it just quietly means something else.
 *
 * ── WHAT MUST NOT CHANGE WITH IT ────────────────────────────────────────────────────────────────
 * Fixed costs are a MONTHLY RATE, not a total of the window: "paid every month whether you sell
 * anything or not" stays true on a twelve-month view and must never become "every Sep – Aug 2026".
 * A period-neutral sentence is not an oversight here; it is the correct one, and section 3 pins it.
 *
 * ── AND THE TO-DATE CLAIM ───────────────────────────────────────────────────────────────────────
 * "short of covering the month so far" is a claim about an in-progress MONTH. It was guarded on
 * `monthInProgress`, which is true of ANY window containing today — including the twelve-month
 * default. Section 4 drives the real page and asserts the line is absent there.
 *
 * ── AND THAT THE NAMED PERIOD IS THE MEASURED ONE ───────────────────────────────────────────────
 * This gate once asserted only that the tiles named the SELECTED window, and was green while they
 * named twelve months over five months of figures. Every tile now clips to the tenant's reporting
 * anchor — one value, applied once before any compute runs — so the assertion is that the tiles,
 * the disclosure and each other all name the same span.
 *
 * Driven through the period control rather than a URL, because there is no URL for it: the preset
 * is client state, restored from localStorage, and a fresh context starts on the default.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, serverReady, explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { chromium } = await import('playwright-core');

const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let browser;
try {
  check('the dev server serves pages before we drive it', await serverReady('/admin/login'));

  // ── 1. THE COPY THAT MUST TAKE THE PERIOD ─────────────────────────────────────────────────────
  // Asserted on the i18n source, because a key that still hardcodes "this month" cannot be made
  // right by the component. Matched as the interpolation token, not the word: `{{period}}` is a
  // shape prose cannot contain by accident.
  console.log('\n— the strings take a period —');
  const dash = JSON.parse(readFileSync('public/locales/en-GB/dashboard.json', 'utf8'));
  const TAKES_PERIOD = ['pnl.breakEvenSub', 'pnl.hoursWentSub', 'pnl.breakEvenOfSellable',
    'pnl.stillToSellHelp', 'pnl.utilZeroAvail', 'pnl.breakEvenRevenue', 'notTrading',
    'manpower.hiresSub', 'manpower.exitsSub'];
  const at = (k) => k.split('.').reduce((o, part) => o?.[part], dash);
  for (const k of TAKES_PERIOD) {
    const v = at(k);
    check(`  ${k} interpolates the period`, typeof v === 'string' && v.includes('{{period}}'), JSON.stringify(v ?? null)?.slice(0, 90));
  }
  for (const k of TAKES_PERIOD) {
    check(`  ${k} no longer says "this month"`, !/this month/i.test(String(at(k) ?? '')));
  }

  // ── 2. AND THE COMPONENT PASSES ONE ───────────────────────────────────────────────────────────
  // A key with a {{period}} nobody fills renders the token to the customer. Matched on the call
  // shape with its argument, never the bare key.
  console.log('\n— and every one of them is given a period —');
  const src = prose('pages/admin/dashboard.tsx');
  for (const k of TAKES_PERIOD) {
    const short = k.replace(/^pnl\.|^manpower\./, '');
    const call = new RegExp(`t\\('(?:pnl\\.|manpower\\.)?${short}'[^)]*period:`);
    check(`  ${short} is called with period:`, call.test(src));
  }

  // ── 3. AND FIXED COSTS STAYS A MONTHLY RATE ───────────────────────────────────────────────────
  console.log('\n— what must stay period-neutral —');
  check('costBaseSub still says the cost is paid every MONTH', /every month/i.test(dash.pnl.costBaseSub),
    'a monthly rate is true on any window; "every Sep – Aug 2026" would not be');
  check('  …and takes no period', !dash.pnl.costBaseSub.includes('{{period}}'));

  // ── 4. THE SERVED PAGE ────────────────────────────────────────────────────────────────────────
  console.log('\n— what the garage actually sees —');
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'domcontentloaded' });

  // The DEFAULT selection is rolling_12 — which is the whole point: the wrong sentence was on the
  // first screen, not on some corner of the picker.
  await page.waitForSelector('[data-testid="period-picker"]', { timeout: 30000 });
  check('the dashboard opens on a twelve-month period',
    (await page.$eval('[data-testid="period-picker"]', (el) => el.value)) === 'rolling_12',
    'so "this month" was the default view’s wording, not an edge case');

  await page.waitForSelector('[data-testid="breakeven-sub"]', { timeout: 40000 });
  const textOf = async (id) => (await page.$(`[data-testid="${id}"]`)) ? (await page.$eval(`[data-testid="${id}"]`, (el) => el.textContent.trim())) : null;

  const be = await textOf('breakeven-sub');
  check('the break-even line does NOT say "this month" on a twelve-month view', !/this month/i.test(be ?? ''), JSON.stringify(be));

  // ── IT NAMES THE WINDOW THE FIGURES COVER, NOT THE ONE PICKED ───────────────────────────────
  // The check this replaces asked only whether a year appeared, and was green while the line named
  // a twelve-month range over five months of figures — passing for a reason that had nothing to do
  // with what it claimed. Every tile now clips to the tenant's reporting anchor, applied once
  // before any compute runs; ZZ's anchor is mid-2026, so a Sept 2025 – Aug 2026 selection is
  // shortened, and the shortening is disclosed once at the head of the strip.
  const note = await textOf('anchor-note');
  check('the shortened window is DISCLOSED, not silently substituted', note !== null,
    note === null ? 'no note — the tiles would name a window the reader never picked, unexplained' : JSON.stringify(note));
  check('  …naming the SETTING rather than an inference', /reporting starts/i.test(note ?? ''),
    'the previous wording explained a decision nobody had made and nobody could change');
  const covered = (note ?? '').match(/cover (.+?) rather than/)?.[1] ?? null;
  check('  …and the window it covers', !!covered, JSON.stringify(covered));
  // Format-independent: whatever monthLabel renders, the tile and the note must name the SAME span.
  check('the break-even line names exactly the window the note discloses',
    !!covered && (be ?? '').includes(covered), `line ${JSON.stringify(be)} vs note window ${JSON.stringify(covered)}`);
  // And discriminating: the SELECTED window starts in the previous calendar year, the covered one
  // does not, so a line still naming the picked range cannot pass this.
  const selected = await page.$eval('[data-testid="period-picker"]', (el) => el.options[el.selectedIndex].textContent);
  check('  …which is NOT the selected one', !/2025/.test(be ?? ''),
    `selected "${selected}" starts in 2025; the covered window does not`);

  // ── AND EVERY TILE NAMES THE SAME ONE ───────────────────────────────────────────────────────
  // This is the assertion that changed when the anchor arrived. It used to require manpower to keep
  // the FULL selection, because manpower did not clip and three other tiles did — a split that was
  // correct only while the dashboard measured two windows at once. One anchor removes the split,
  // so the check becomes the stronger one: the money tile and the people tile agree.
  const hires = await textOf('manpower-hires');
  check('a people tile names the SAME window as a money tile', !!covered && (hires ?? '').includes(covered),
    `manpower ${JSON.stringify((hires ?? '').slice(0, 70))} vs ${JSON.stringify(covered)}`);

  const cb = await textOf('costbase-sub');
  check('fixed costs still says every month, on the same screen', /every month/i.test(cb ?? ''), JSON.stringify(cb));

  // ── 5. THE TO-DATE CLAIM IS NOT MADE ABOUT A YEAR ─────────────────────────────────────────────
  const np12 = await textOf('netprofit-progress');
  check('net profit makes no "month so far" claim on a twelve-month view', np12 === null,
    np12 === null ? 'the line is absent, as it must be' : `RENDERED: ${JSON.stringify(np12)} — monthInProgress is true of any window containing today`);

  // And it is not simply deleted: on a single month in progress it MUST still appear. Selecting
  // the real control, because the preset is client state with no URL of its own.
  await page.selectOption('[data-testid="period-picker"]', 'this_month');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="breakeven-sub"]');
    return el && !/–/.test(el.textContent);           // the range dash is gone → a single month
  }, { timeout: 40000 });
  const be1 = await textOf('breakeven-sub');
  check('a single month names that month', /\d{4}/.test(be1 ?? '') && !/–/.test(be1 ?? ''), JSON.stringify(be1));
  // A month wholly inside the data is not clipped, so the disclosure must NOT appear: a note on
  // every view would be wallpaper, and wallpaper is not read.
  check('  …and no shortening note, because nothing was shortened', (await textOf('anchor-note')) === null,
    'the note earns attention by being rare');
  const np1 = await textOf('netprofit-progress');
  check('  …and the to-date line comes BACK for the month in progress', np1 !== null,
    np1 === null ? 'absent — the guard is now too strict, which is the opposite failure' : JSON.stringify(np1));
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
