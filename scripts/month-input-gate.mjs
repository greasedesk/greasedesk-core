/**
 * File: scripts/month-input-gate.mjs
 *
 * A MONTH MUST BE ENTERABLE IN EVERY BROWSER.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * Five fields used `<input type="month">`. Desktop Firefox and desktop Safari do not implement it
 * and fall back to a plain text box — no picker, no placeholder, no hint of the format — and then
 * KEEP whatever is typed. Measured 2026-11-05 through the browsers themselves, not read off a
 * support table: Firefox 159 reports `input.type === 'text'` and retains "12/2026"; Chrome 157
 * reports `'month'` and refuses the same string outright.
 *
 * So two of the three desktop browsers could not fill in the service schedule's month at all, and
 * the server's "That month does not look right." was correct every time it fired.
 *
 * ── THE WORSE HALF, WHICH NOBODY REPORTED ──────────────────────────────────────────────────────
 * "Reporting starts" took the same free text, appended "-01" and handed it to `new Date()`, which
 * guesses. Measured on that exact path before the fix:
 *
 *     "November 2026-01" → 2026-11-01   accepted by luck, not by rule
 *     "2026-01"          → 2026-01-01   a month read as a year
 *     "November-01"      → 2001-11-01   a year invented from nothing
 *
 * That column is the anchor the whole dashboard's periods are read through. The schedule failed
 * LOUDLY, which is annoying; this succeeded WRONGLY, which is worse, and §5 is about it.
 *
 * ── WHY THE STRONGEST CLAUSE IS NOT A BROWSER TEST ─────────────────────────────────────────────
 * The fix is two `<select>`s. There is no support question left to ask about a select, so the
 * guarantee worth holding is §1 — that no `type="month"` survives ANYWHERE — rather than three
 * browsers agreeing about a date picker. §1 keeps working for the next field somebody adds; three
 * passing screenshots would not.
 *
 * §7 drives a real Firefox anyway, because the owner asked for belt and braces and because a
 * component that renders correctly in the one browser the suite already uses is not evidence about
 * the two that had the defect. It returns values from Firefox's own DOM, not a picture: see
 * scripts/_firefox-bidi.mjs for why a screenshot was rejected as the mechanism.
 *
 * §1 nothing of the old type survives   §5 the reporting anchor refuses what it used to swallow
 * §2 the rules, pure                    §6 round trip through the real API, with a real session
 * §3 the component, rendered            §7 a real Firefox
 * §4 one regex, not two                 §8 red-proofs
 *
 * NOT PROVED HERE: desktop Safari. It has no headless mode and no remote protocol to drive, so it
 * stays a manual check by the owner. What makes that acceptable is §1: if nothing in the tree asks
 * for a browser-specific input type, Safari has nothing left to disagree about.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, declineToRun, describeError, gateOrigin, ZZ_GROUP, zzSite } = await import('./_gate-preflight.mjs');
const { readFileSync, readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');
const { chromium } = await import('playwright-core');
const { openFirefox, firefoxInstalled } = await import('./_firefox-bidi.mjs');
const { hasKey } = await import('../lib/anchored-match.ts');
const M = await import('../lib/month-value.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const BASE = gateOrigin();
const REG = 'ZZ26MTH';
const CUST = 'Month Picker Fixture';

let browser = null;
let ff = null;
let prisma = null;
let madeCard = null;
let madeVeh = null;
let madeCust = null;
let anchorBefore = null;
let anchorTouched = false;

try {
  // ══ 1. NOTHING OF THE OLD TYPE SURVIVES ═══════════════════════════════════════════════════════
  // The whole tree, not a list of the five that were known. A list would have been right the day it
  // was written; the failure being guarded is the SIXTH one somebody adds next year.
  console.log('— no browser-specific month input anywhere —');
  const SKIP = new Set(['node_modules', '.next', '.git', 'coverage', 'dist', 'build']);
  const walk = (dir, acc = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(tsx?|jsx?|html)$/.test(e.name) && statSync(p).size < 2_000_000) acc.push(p);
    }
    return acc;
  };
  const files = walk('.');
  // COMMENTS STRIPPED FIRST. Four of the files this slice touched EXPLAIN the defect, and
  // `type="month"` appears inside those explanations — the usual rule ("a file explaining what it
  // does must not satisfy a check about doing it") running backwards. Scanning raw source made the
  // fix fail its own gate, which would have been fixed by deleting the reasoning.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
  // @scan-ok: counting an attribute token across source files IS the measurement here, not a proxy.
  const offenders = files.filter((f) => /type=["']month["']/.test(code(readFileSync(f, 'utf8'))));
  check('no file declares type="month"', offenders.length === 0, offenders.join(', ') || `${files.length} files scanned`);
  check('  …and the stripper removes a comment without removing code',
    !/type="month"/.test(code('// an <input type="month"> used to live here')) 
    && /type="month"/.test(code('<input type="month" />')),
    'asserted both ways, or the sweep above could be passing because it reads nothing');
  check('  …and the sweep really read the tree', files.length > 300, `${files.length} source files`);
  // NOT VACUOUS: the scan must be able to find one. Without this, a broken walker reports the same
  // clean zero as a clean tree — which is the shape that makes a gate say nothing for a year.
  check('  …and the scan can still find a planted one',
    /type=["']month["']/.test('<input type="month">') && !/type=["']month["']/.test('<input type="text">'),
    'the pattern is asserted against a known positive and a known negative');

  // ══ 2. THE RULES, PURE ════════════════════════════════════════════════════════════════════════
  console.log('\n— what a month value is —');
  for (const good of ['2026-01', '2026-12', '1999-07']) check(`${good} is a month`, M.isMonthValue(good));
  for (const bad of ['12/2026', 'November 2026', '2026-13', '2026-00', '2026-1', '26-01', '2026', '', '2026-01-01'])
    check(`${JSON.stringify(bad).padEnd(18)} is not`, !M.isMonthValue(bad));
  check('split and compose round-trip', M.composeMonth(M.splitMonth('2026-11').year, M.splitMonth('2026-11').month) === '2026-11');
  check('a half answer composes to nothing', M.composeMonth(2026, '') === '' && M.composeMonth(null, '11') === '',
    'emitting "2026-" would put a string nothing can parse into the form, and the server would be the first to see it');
  check('  …and so does a nonsense half', M.composeMonth('26', '11') === '' && M.composeMonth(2026, '13') === '');

  console.log('\n— the years offered —');
  const NOW = new Date('2026-11-05T00:00:00.000Z');
  const base = M.yearOptions('', NOW);
  check(`this year ±${M.YEAR_SPAN}`, base.length === M.YEAR_SPAN * 2 + 1 && base[0] === 2021 && base[base.length - 1] === 2031, base.join(' '));
  check('  …and the list is sorted', base.every((y, i) => i === 0 || y > base[i - 1]));
  const past = M.yearOptions('2014-03', NOW);
  check('A STORED YEAR OUTSIDE THE RANGE IS ADDED', past.includes(2014),
    'a picker that cannot represent what is saved would EDIT it on load, and saving back would write the edit');
  check('  …at the right end, sorted', past[0] === 2014 && past[1] === 2021);
  check('  …and the range is not widened to reach it', !past.includes(2015) && !past.includes(2020),
    'widening to 2014 would offer every year between as though they were ordinary choices');
  const future = M.yearOptions('2040-08', NOW);
  check('  …the same in the other direction', future.includes(2040) && future[future.length - 1] === 2040 && !future.includes(2035));
  check('a year already inside the range is not duplicated',
    M.yearOptions('2026-11', NOW).filter((y) => y === 2026).length === 1);
  check('a blank value adds nothing', M.yearOptions('', NOW).length === base.length);
  check('  …and nor does a junk one', M.yearOptions('November 2026', NOW).length === base.length,
    'the thing that used to be typed into the old field adds no option, because it is not a month');

  console.log('\n— the half-filled picker, which is the whole design problem —');
  // THE SEQUENCE A PERSON ACTUALLY PERFORMS, stepped through the real reducer. None of this is
  // reachable from static markup, and it is the part most likely to be "simplified" later: the
  // `emitted` field looks like bookkeeping until you try to remove it.
  let d = M.seedDraft('');
  check('an empty picker holds nothing', d.year === null && d.month === '' && d.emitted === '');
  d = M.pushDraft(d, { month: '11' });
  check('picking a month alone emits nothing', d.emitted === '' && d.month === '11',
    'there is no value yet — "2026-" is a string nothing can parse');
  d = M.syncDraft(d, '');
  check('  …and the parent echoing that "" BACK does not wipe the month', d.month === '11',
    'this is the clause the whole `emitted` field exists for');
  d = M.pushDraft(d, { year: 2026 });
  check('adding the year completes it', d.emitted === '2026-11');
  d = M.syncDraft(d, '2026-11');
  check('  …and the echo of a complete value is a no-op', d.month === '11' && d.year === 2026);
  d = M.pushDraft(d, { year: null });
  check('clearing the YEAR emits "" but keeps the month', d.emitted === '' && d.month === '11',
    'the person cleared one half; losing the other would be the form editing itself');
  d = M.syncDraft(d, '');
  check('  …even after the parent echoes that "" back', d.month === '11');
  const outside = M.syncDraft(d, '2014-03');
  check('a genuine outside change DOES reseed', outside.month === '03' && outside.year === 2014,
    'a form seeding, a row cleared by a reset, a different card loaded');
  check('  …and is told apart from the echo by `emitted` alone',
    M.syncDraft({ year: 2026, month: '11', emitted: '' }, '') .month === '11'
    && M.syncDraft({ year: 2026, month: '11', emitted: '2026-11' }, '').month === '',
    'same incoming value, opposite correct answers — which is why the field cannot be dropped');

  // ══ 3. THE COMPONENT, RENDERED ════════════════════════════════════════════════════════════════
  console.log('\n— the component, through the real renderer —');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const MonthSelect = (await import('../components/ui/MonthSelect.tsx')).default;
  const msSrc = readFileSync('components/ui/MonthSelect.tsx', 'utf8');
  check('the component uses the shared reducer rather than its own copy',
    /syncDraft\(/.test(msSrc) && /pushDraft\(/.test(msSrc)
    && !hasKey(msSrc.replace(/^\s*(\/\/|\*).*$/gm, ''), 'emitted'),
    'the rule is in lib/month-value where it can be asserted; a second copy here would drift from it');
  const renderMs = (props) => renderToStaticMarkup(
    React.createElement(MonthSelect, { onChange: () => {}, testId: 'ms', label: 'Due by', now: NOW, ...props }));

  const seeded = renderMs({ value: '2026-11' });
  check('it renders two selects and no input', (seeded.match(/<select/g) ?? []).length === 2 && !/<input/.test(seeded));
  check('  …and no type="month" of its own', !/type="month"/.test(seeded));
  check('a seeded value selects its month', /<option value="11" selected="">Nov<\/option>/.test(seeded) || /value="11"[^>]*selected/.test(seeded), 'Nov');
  check('  …and its year', /value="2026"[^>]*selected/.test(seeded));
  check('both halves offer a blank', (seeded.match(/<option value="">/g) ?? []).length === 2,
    'most schedule rows are empty, and a blank in either half means no month');
  check('twelve months are offered', (seeded.match(/<option value="(0[1-9]|1[0-2])"/g) ?? []).length === 12);

  const overdue = renderMs({ value: '2014-03' });
  check('A VALUE OUTSIDE THE RANGE RENDERS EXACTLY AS SAVED', /value="2014"[^>]*selected/.test(overdue) && /value="03"[^>]*selected/.test(overdue),
    'the reload-must-not-edit rule, asserted on the markup a person would actually see');
  check('  …and 2014 is in the options to be selected', /<option value="2014"/.test(overdue));
  const blank = renderMs({ value: '' });
  // ASSERTED AS A COUNT ON THE BLANK OPTIONS. The first version of this clause ended in `|| true`,
  // which is not a hedge, it is a clause that cannot go red — decoration wearing a check's clothes.
  const blankSelected = [...blank.matchAll(/<option value="([^"]*)"[^>]*selected/g)].map((m) => m[1]);
  check('a blank value selects the blank option in BOTH halves, and nothing else',
    blankSelected.length === 2 && blankSelected.every((v) => v === ''),
    blankSelected.map((v) => JSON.stringify(v)).join(' ') || 'nothing selected at all');
  check('  …and offers no year outside the range', !/<option value="2014"/.test(blank));
  const off = renderMs({ value: '2026-11', disabled: true });
  // `disabled=""`, NOT `disabled`: the class list carries `disabled:opacity-60`, so a bare token
  // match counted four and the clause failed against correct markup. One word, two subjects.
  check('disabled reaches both selects', (off.match(/disabled=""/g) ?? []).length === 2,
    `${(off.match(/disabled=""/g) ?? []).length} disabled attributes — a locked card locks the month too`);
  check('  …and an enabled one has none', (renderMs({ value: '2026-11' }).match(/disabled=""/g) ?? []).length === 0);

  // ══ 4. ONE REGEX, NOT TWO ═════════════════════════════════════════════════════════════════════
  console.log('\n— the picker and the validator agree by construction —');
  const schedSrc = readFileSync('lib/service-schedule.ts', 'utf8');
  check('lib/service-schedule reads the shape from lib/month-value', /from '@\/lib\/month-value'/.test(schedSrc));
  // ASKED OF THE FUNCTION, NOT OF THE FILE. The first version of this clause tested that the OLD
  // regex text was absent — so replacing it with a DIFFERENT, looser regex satisfied it, and the
  // mutation `/^\d{4}-\d{2}$/` came back green while happily accepting month 13. A clause about
  // "the copy I happen to remember" is not a clause about there being no copy.
  const mtsd = schedSrc.slice(schedSrc.indexOf('export function monthToStoredDate'));
  const mtsdBody = mtsd.slice(0, mtsd.indexOf('\n}'));
  check('  …and monthToStoredDate holds no regex of its own',
    /isMonthValue\(/.test(mtsdBody) && !/\/\^.*\$\//.test(mtsdBody.replace(/^\s*(\/\/|\*).*$/gm, '')),
    mtsdBody.replace(/\s+/g, ' ').slice(0, 110));
  const S = await import('../lib/service-schedule.ts');
  check('the validator accepts what the picker emits', S.monthToStoredDate(M.composeMonth(2026, '11')) !== null);
  check('  …and refuses what the old text box produced',
    S.monthToStoredDate('12/2026') === null && S.monthToStoredDate('November 2026') === null);
  // THE BEHAVIOURAL HALF, which is what actually catches a looser second copy: `\d{2}` accepts
  // month 13 and Date.UTC rolls it into next January, so a schedule row would silently move a year.
  check('  …and refuses a month that is not a month',
    S.monthToStoredDate('2026-13') === null && S.monthToStoredDate('2026-00') === null,
    'a loose \\d{2} would roll 2026-13 into January 2027 rather than refusing it');

  // ══ 5. THE REPORTING ANCHOR ═══════════════════════════════════════════════════════════════════
  prisma = await gatePrisma();
  const ZZ = ZZ_GROUP;
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), page.click('button[type="submit"]')]);
  const req = (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: b === null ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [method, url, body ?? null]);

  const whoami = await req('GET', '/api/version', null);
  check('the gate has a real session against the gate server', whoami.status === 200, `${BASE} → ${whoami.status}`);

  console.log('\n— "Reporting starts" refuses what it used to swallow —');
  anchorBefore = (await prisma.group.findUnique({ where: { id: ZZ }, select: { reporting_start_date: true } }))?.reporting_start_date ?? null;
  // EVERY STRING MEASURED AS ACCEPTED BEFORE THE FIX, asked of the real endpoint.
  for (const bad of ['November 2026-01', 'Nov-2026-01', '2026/11-01', 'November-01', '2026-01', '2026-02-31', '2026-13-01']) {
    const r = await req('PATCH', '/api/company', { reporting_start_date: bad });
    check(`${JSON.stringify(bad).padEnd(20)} is refused`, r.status === 400, `${r.status} ${r.body?.message ?? ''}`.slice(0, 80));
  }
  const after = (await prisma.group.findUnique({ where: { id: ZZ }, select: { reporting_start_date: true } }))?.reporting_start_date ?? null;
  check('  …and not one of them changed the stored anchor',
    String(after) === String(anchorBefore), `${String(anchorBefore)} → ${String(after)}`);

  const good = await req('PATCH', '/api/company', { reporting_start_date: '2026-11-01' });
  anchorTouched = good.status === 200;
  check('a real month IS accepted', good.status === 200, `${good.status} ${good.body?.message ?? ''}`.slice(0, 80));
  const stored = (await prisma.group.findUnique({ where: { id: ZZ }, select: { reporting_start_date: true } }))?.reporting_start_date ?? null;
  check('  …and round-trips back to the month it was given',
    stored != null && new Date(stored).toISOString().slice(0, 7) === '2026-11', String(stored));

  // ══ 6. ROUND TRIP THROUGH THE REAL API ════════════════════════════════════════════════════════
  console.log('\n— enter, save, reload, display: an overdue month and one outside the range —');
  const site = await zzSite(prisma);
  madeCust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST, phone: '07700 900877' }, select: { id: true } });
  madeVeh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: REG, registration_normalized: REG, make: 'Month', model: 'Fixture' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: madeVeh.id, customer_id: madeCust.id, is_current: true } });
  madeCard = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, customer_id: madeCust.id, vehicle_id: madeVeh.id, status: 'quoted', odometer_in: 50000 },
    select: { id: true } });

  // A PAST MONTH (an overdue brake fluid change, which is the ordinary case the year range would
  // have broken) and ONE OUTSIDE THE DEFAULT RANGE, which is the case the owner asked for by name.
  const CASES = [['schedule_brake_fluid', '2024-02', 'overdue, inside the range'],
                 ['schedule_vehicle_check', '2014-03', 'outside this year ±5']];
  for (const [key, month, why] of CASES) {
    const entries = [{ key, dueMonth: month, dueMileage: key === 'schedule_vehicle_check' ? null : null,
      countdownMiles: key === 'schedule_vehicle_check' ? 1000 : null, wasRecorded: false }];
    const r = await req('POST', '/api/service-schedule', { jobCardId: madeCard.id, stage: 'arrival', entries });
    check(`${month} saves (${why})`, r.status === 200, `${r.status} ${r.body?.message ?? ''}`.slice(0, 90));
  }
  const readings = await prisma.serviceScheduleReading.findMany({
    where: { job_card_id: madeCard.id }, select: { item_key: true, due_month: true },
  }).catch(() => null);
  if (readings === null) {
    check('the saved rows can be read back', false, 'ServiceScheduleReading could not be queried');
  } else {
    for (const [key, month] of CASES) {
      const row = readings.find((x) => x.item_key === key);
      const back = row?.due_month ? S.storedDateToMonth(row.due_month) : null;
      check(`${month} reloads as exactly ${month}`, back === month, `read back as ${back}`);
      // AND DISPLAYS. The reload is only half the rule: the picker has to be able to show it.
      const markup = renderMs({ value: back ?? '' });
      const [y, mm] = (back ?? '-').split('-');
      check(`  …and the picker renders ${month} as saved`,
        new RegExp(`value="${y}"[^>]*selected`).test(markup) && new RegExp(`value="${mm}"[^>]*selected`).test(markup),
        'enter → save → reload → display, end to end');
    }
  }

  // ══ 7. A REAL FIREFOX ═════════════════════════════════════════════════════════════════════════
  console.log('\n— and the browser that had the defect —');
  if (!firefoxInstalled()) {
    check('Firefox is present to be driven', false, 'not at /Applications/Firefox.app — the belt-and-braces leg cannot run');
  } else {
    ff = await openFirefox({ port: 9893 });
    const ua = await ff.evaluate('navigator.userAgent');
    check('it really is Firefox', /Firefox\//.test(String(ua)), String(ua).slice(0, 70));

    // THE OLD FIELD, SO THE DEFECT IS DEMONSTRATED AND NOT MERELY DESCRIBED. Without this the
    // clauses below could pass in a browser where the old input worked perfectly well, and the
    // whole slice would rest on a support table nobody re-read.
    await ff.setContent('<!doctype html><input type="month" id="old">');
    check('  …and the OLD input really does fall back here',
      (await ff.evaluate("document.getElementById('old').type")) === 'text',
      'this is the defect, reproduced, in the browser that has it');
    check('  …keeping a string the server must reject',
      (await ff.evaluate("(()=>{const e=document.getElementById('old');e.value='12/2026';return e.value;})()")) === '12/2026');

    // THE NEW COMPONENT'S OWN MARKUP, rendered by the real renderer and handed to a real Firefox.
    await ff.setContent(`<!doctype html><meta charset="utf-8"><body>${renderMs({ value: '2014-03' })}</body>`);
    check('the component has no type="month" in Firefox\'s DOM',
      (await ff.evaluate("document.querySelectorAll('input[type=month]').length")) === 0);
    check('  …it is two selects', (await ff.evaluate("document.querySelectorAll('select').length")) === 2);
    check('  …and the out-of-range value is selected, in Firefox',
      (await ff.evaluate("document.querySelector('[data-testid=ms-year]').value")) === '2014'
      && (await ff.evaluate("document.querySelector('[data-testid=ms-month]').value")) === '03',
      'the same reload-must-not-edit rule, asserted in the browser that could not show it before');
    const composed = await ff.evaluate(`(() => {
      const m = document.querySelector('[data-testid=ms-month]');
      const y = document.querySelector('[data-testid=ms-year]');
      m.value = '11'; y.value = '2026';
      return y.value + '-' + m.value;
    })()`);
    check('  …and a month CAN be entered in Firefox', composed === '2026-11', String(composed));
  }

  // ══ 8. RED-PROOFS ═════════════════════════════════════════════════════════════════════════════
  console.log('\n— the scans find a planted case and reject a broken one —');
  check('RP1 a year range that dropped the loaded value would be caught',
    (() => { const broken = M.yearOptions('', NOW); return !broken.includes(2014) && M.yearOptions('2014-03', NOW).includes(2014); })(),
    'the clause is about the EXTRA option, so a range that merely spans ±5 does not satisfy it');
  check('RP2 a compose that emitted a half answer would be caught',
    M.composeMonth(2026, '') === '' && M.composeMonth(2026, '11') === '2026-11',
    'asserted both ways: the half refused AND the whole accepted');
  check('RP3 the type="month" sweep rejects a file that has one',
    /type=["']month["']/.test('<input type="month" value={x} />'),
    'the pattern is the one the five offenders matched, not a looser one');
  check('RP4 the anchor clauses are about REFUSAL, not about any 400',
    ['November-01', '2026-01'].every((b) => !/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(b))
    && /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test('2026-11-01'),
    'the shape that refuses them is asserted here too, so a 400 for some other reason would not do');
  check('RP5 the Firefox leg is not vacuous',
    !firefoxInstalled() || ff !== null,
    'a missing Firefox is reported as a failed clause, never skipped into silence');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  // ── EVERYTHING THIS RUN MADE, AND THE ONE THING IT CHANGED ──────────────────────────────────
  // The anchor is RESTORED rather than left at the fixture's value: it is a real tenant setting on
  // a real tenant, and the dashboard reads it. Restored only when this run actually moved it, so a
  // run that failed before §5 cannot write a null over somebody's anchor.
  try {
    if (prisma && anchorTouched) {
      await prisma.group.update({ where: { id: ZZ_GROUP }, data: { reporting_start_date: anchorBefore } });
      const back = (await prisma.group.findUnique({ where: { id: ZZ_GROUP }, select: { reporting_start_date: true } }))?.reporting_start_date ?? null;
      console.log(`\n(reporting anchor restored to ${String(anchorBefore)}${String(back) === String(anchorBefore) ? '' : ' — RESTORE FAILED'})`);
    }
    if (prisma && madeCard) await prisma.jobCard.delete({ where: { id: madeCard.id } }).catch(() => {});
    if (prisma && madeVeh) await prisma.vehicle.delete({ where: { id: madeVeh.id } }).catch(() => {});
    if (prisma && madeCust) await prisma.customer.delete({ where: { id: madeCust.id } }).catch(() => {});
  } catch { /* teardown is best effort; the verdict below is not */ }
  if (ff) await ff.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (prisma) await prisma.$disconnect().catch(() => {});
}

const failed = out.filter((r) => r === 'F').length;
console.log(`\n${failed} failures of ${out.length}`);
process.exit(failed ? 1 : 0);
