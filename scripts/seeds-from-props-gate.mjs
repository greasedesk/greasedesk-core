/**
 * File: scripts/seeds-from-props-gate.mjs
 *
 * SEEDED ONCE IS NOT SEEDED — a form that copies server data into useState at mount, and never
 * again, shows whatever was true when it mounted.
 *
 * Five instances, every one reported by the owner using the product, none by this suite:
 *   PhoneTyres, PhoneServiceSchedule, TyreCapture   (fixed — cache-first first paint)
 *   BatteryCapture, PhoneBattery                    (milder — carried-forward hints)
 *   ServiceSchedule (desktop)                       (2026-08-21 — DELETED FIVE REAL READINGS)
 *
 * The fifth is why this gate exists and why it is not only about display. On TMBS card D13DSK the
 * owner recorded five schedule items, switched tab, came back to an empty form, and saved:
 *
 *     09:22:48  arrival  written=5  cleared=0
 *     09:23:37  arrival  written=0  cleared=5      <- the empty form, saved
 *
 * pages/api/service-schedule.ts treats a blank row as "clear this item", which is correct when a
 * person clears it and catastrophic when the form cleared itself. Staleness plus a destructive
 * write is data loss, not a display bug.
 *
 * ── WHY THE EARLIER ANALYSIS MISSED THE DESKTOP ────────────────────────────────────────────────
 * It said server-rendered props are fresh on first render, so a desktop component needs no re-seed.
 * True on page load. NOT true on a tab switch: the workspace mounts its panes as
 * `{active === 'intake' && (...)}`, so switching UNMOUNTS the pane and returning MOUNTS A NEW ONE,
 * whose useState initialiser runs again against whatever the parent is still holding. No cache is
 * involved. That is the case this gate is built around.
 *
 * ── THE POPULATION, AND WHY IT IS THIS ONE ─────────────────────────────────────────────────────
 * Three conditions, each one narrowing a number that was unusable without it:
 *   every non-trivial useState seed anywhere          203
 *   ...that also writes back to an API                170   (staleness is only destructive if saved)
 *   ...in a component some parent mounts conditionally 15   (only these can remount mid-page)
 * The last condition is the one that matters: a page seeded from getServerSideProps cannot remount
 * without a navigation that re-runs SSR. A component behind `{cond && <C/>}` can, and does.
 *
 * ── DECLARE, DON'T GUESS ───────────────────────────────────────────────────────────────────────
 * Of the 15, most are NEW-ENTRY DEFAULTS (today's date, the first payment method, 'form') rather
 * than seeds of a saved value, and re-seeding those would be wrong. Rather than encode a guess
 * about which is which, every flagged state must either re-seed or be DECLARED below with a
 * reason — the same bargain as lib/invoice-snapshots. An undeclared one fails the gate.
 */
import './_gate-preflight.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── DECLARED: seeds once ON PURPOSE ────────────────────────────────────────────────────────────
// Key is file:stateName — never a line number, which moves for reasons that have nothing to do
// with the rule. The reason has to say which KIND of seed it is.
const DECLARED = {
  'components/jobcard/BatteryCapture.tsx:ratedCca':
    'carried-forward HINT for a new reading (last known rating), not this card’s saved value — the saved one is displayed by BatterySummary and is never re-edited here',
  'components/jobcard/BatteryCapture.tsx:std':
    'as ratedCca — the CCA standard that came with the carried-forward rating',
  'components/refund/RefundPanel.tsx:stage':
    'new-entry UI state (form → confirm); there is no saved value to be stale against',
  'components/refund/RefundPanel.tsx:methodId':
    'new-entry default (first available method), not a seed of a recorded refund',
  'components/refund/RefundPanel.tsx:when':
    'new-entry default (today); re-seeding would move a date the user had chosen',
  'components/jobcard/JobCardWorkspace.tsx:unread':
    'a counter for a badge — displayed, never posted back, so staleness cannot be written',
  'components/jobcard/JobCardWorkspace.tsx:liftId':
    'booking editor, seeded from `booking` — which IS reconciled through the overlay by refreshCard, so the prop it re-mounts against is fresh',
  'components/jobcard/JobCardWorkspace.tsx:startDate': 'as liftId — booking editor on the reconciled `booking` prop',
  'components/jobcard/JobCardWorkspace.tsx:startTime': 'as liftId — booking editor on the reconciled `booking` prop',
  'components/jobcard/JobCardWorkspace.tsx:durSel': 'as liftId — booking editor on the reconciled `booking` prop',
  'components/jobcard/JobCardWorkspace.tsx:freeHours': 'as liftId — booking editor on the reconciled `booking` prop',
  'components/jobcard/JobCardWorkspace.tsx:val':
    'mileage-out, deliberately NOT prefilled — see the comment at its declaration; a measurement, never a default',
  'components/messages/ConversationView.tsx:channel':
    'new-entry default (email); the composer’s channel, not a stored fact',
  'components/messages/ConversationView.tsx:allowance':
    'an SMS quota shown beside the composer; refreshed by the send path, never posted back',
};

function bal(src, i, open, close) {
  let d = 0, o = '';
  for (; i < src.length; i++) { const c = src[i];
    if (c === open) { d++; if (d === 1) continue; }
    if (c === close) { d--; if (!d) break; }
    o += c; }
  return o;
}
const TRIVIAL = /^\s*(''|""|``|false|true|null|undefined|0|\[\]|\{\}|new Set\(\)|new Map\(\))\s*$/;
const WRITES_BACK = /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/;

/** Components that some parent mounts inside a conditional JSX region — these can remount mid-page. */
function conditionallyMounted(files, read) {
  const m = new Map();
  for (const f of files) {
    const src = read(f);
    for (const c of src.matchAll(/\{\s*[^{}\n]*?(?:&&|\?)\s*\(/g)) {
      // the WHOLE region, not just its first child: everything inside a tab pane remounts with it,
      // however deep. Scoping to the first element missed ServiceSchedule, which sits nine
      // elements into the Intake pane — i.e. it missed the defect that prompted the gate.
      const region = bal(src, c.index, '{', '}');
      const line = src.slice(0, c.index).split('\n').length;
      for (const el of region.matchAll(/<([A-Z]\w+)/g))
        (m.get(el[1]) ?? m.set(el[1], []).get(el[1])).push(`${f}:${line}`);
    }
  }
  return m;
}

/** Every seed-once-from-a-non-trivial-value in a remountable, write-back component. */
function scan(files, read) {
  const byName = new Map();
  for (const f of files) { const n = f.split('/').pop().replace('.tsx', ''); if (/^[A-Z]/.test(n)) byName.set(n, f); }
  const flagged = [];
  for (const [name, parents] of conditionallyMounted(files, read)) {
    const f = byName.get(name); if (!f) continue;
    const src = read(f);
    if (!WRITES_BACK.test(src)) continue;
    const effects = [...src.matchAll(/useEffect\(/g)].map((e) => bal(src, e.index + e[0].length - 1, '(', ')'));
    for (const m of src.matchAll(/const\s*\[\s*(\w+)\s*,\s*(set\w+)\s*\]\s*=\s*useState(?:<[^>]*>)?\s*\(/g)) {
      const init = bal(src, m.index + m[0].length - 1, '(', ')');
      if (TRIVIAL.test(init) || !init.trim()) continue;
      if (effects.some((b) => new RegExp(`\\b${m[2]}\\b`).test(b))) continue;   // re-seeds — the fixed shape
      flagged.push({ file: f, state: m[1], line: src.slice(0, m.index).split('\n').length, parents: [...new Set(parents)] });
    }
  }
  return flagged;
}

const files = execSync("find components pages -name '*.tsx'", { encoding: 'utf8' }).trim().split('\n');
const read = (f) => readFileSync(f, 'utf8');
const flagged = scan(files, read);

// ── 1. THE POPULATION IS DECLARED ──────────────────────────────────────────────────────────────
const undeclared = flagged.filter((h) => !DECLARED[`${h.file}:${h.state}`]);
check('every seed-once in a remountable, write-back component is declared', undeclared.length === 0,
  undeclared.length
    ? `\n    ${undeclared.map((h) => `${h.file}:${h.line}  ${h.state}   (remounts inside ${h.parents[0]})`).join('\n    ')}\n    Re-seed it (fingerprint + a dirty guard), or add it to DECLARED with which KIND of seed it is`
    : `${flagged.length} declared, none undeclared`);

// A register that has outlived its entries stops being read. Stale keys are the same rot as a
// stale comment, and they are the reason a register can quietly become decoration.
const live = new Set(flagged.map((h) => `${h.file}:${h.state}`));
const dead = Object.keys(DECLARED).filter((k) => !live.has(k));
check('no DECLARED entry describes a state that no longer exists', dead.length === 0,
  dead.length ? `stale: ${dead.join(', ')} — the state was renamed, removed, or now re-seeds` : 'the register matches the code');

// ── 2. POSITIVE CONTROLS: THE DETECTOR CAN STILL SEE ONE ───────────────────────────────────────
// A green gate is worthless if the scan silently stopped matching. Two synthetic components, one
// of each shape, run through the SAME scan() the real files go through.
const BAD = `
export default function FakeForm({ recorded }: Props) {
  const seed = build(recorded);
  const [rows, setRows] = useState(seed);
  async function save() { await fetch('/x', { method: 'POST', body: JSON.stringify(rows) }); }
  return <div/>;
}`;
const GOOD = BAD.replace('async function save()',
  'useEffect(() => { setRows(build(recorded)); }, [recorded]);\n  async function save()');
const PARENT = `export default function P(){ return <div>{active === 'x' && (<><Other/><FakeForm recorded={r}/></>)}</div>; }`;
const synthetic = (body) => {
  const fake = { 'components/fake/FakeForm.tsx': body, 'pages/fake-parent.tsx': PARENT };
  return scan([...Object.keys(fake)], (f) => fake[f] ?? read(f)).filter((h) => h.file.includes('FakeForm'));
};
check('a seed-once form IS flagged', synthetic(BAD).length === 1, 'the scan can still see the shape it is for');
check('the same form WITH a re-seed effect is NOT flagged', synthetic(GOOD).length === 0,
  'and the fix is what clears it — not merely a different file');

// ── 3. THE INSTANCE THAT COST FIVE READINGS ────────────────────────────────────────────────────
// Both halves, because either alone leaves the defect live. The component re-seeding against a
// prop the parent never updates re-seeds the same stale value; the parent reconciling a prop the
// component reads only at mount never reaches the form.
const ss = read('components/jobcard/ServiceSchedule.tsx');
// PIN THE RULE, NOT THE CALL SHAPE. This matched `setRows(seedFrom(recorded))` exactly, so adding
// a second argument to seedFrom read as "the re-seed was removed". What matters is that a useEffect
// keyed on the recorded rows puts them back into state.
const reseedEffect = (() => {
  const i = ss.indexOf('useEffect(');
  if (i < 0) return '';
  let d = 0, out = '';
  for (let j = ss.indexOf('(', i); j < ss.length; j++) {
    const c = ss[j];
    if (c === '(') { d++; if (d === 1) continue; }
    if (c === ')') { d--; if (!d) break; }
    out += c;
  }
  return out;
})();
check('ServiceSchedule re-seeds when the recorded rows change',
  /setRows\(\s*seedFrom\(\s*recorded/.test(reseedEffect) && /fingerprint/.test(reseedEffect),
  'an effect keyed on the recorded rows, not a particular call signature');
check('  …and will not overwrite half-typed work', /if\s*\(dirty\b/.test(ss),
  'a dirty guard, cleared on a successful save so the guard cannot latch on for the life of the mount');
check('  …and clears dirty once what was typed is what is stored', /setDirty\(false\)/.test(ss));

const ws = read('components/jobcard/JobCardWorkspace.tsx');
const overlay = bal(ws, ws.indexOf('setOv({', ws.indexOf('async function refreshCard')), '(', ')');
check('refreshCard reconciles BOTH service-computer reads',
  /scheduleOnArrival:/.test(overlay) && /serviceSchedule:/.test(overlay),
  'the pane endpoint always returned them; the overlay simply did not copy them');
for (const [label, pat] of [['arrival', /recorded=\{eff\.scheduleOnArrival/], ['departure', /recorded=\{eff\.serviceSchedule/]])
  check(`  …and the ${label} panel reads the reconciled value, not the page-load one`, pat.test(ws));

// ── 4. THE AMPLIFIER IS STILL THERE, AND SHOULD BE SEEN ────────────────────────────────────────
// Not a failure — clearing a mis-read row is a real thing a person does, and refusing it would be
// worse. But it is the reason a display bug became data loss, so it is asserted rather than
// remembered: if this stops being true, the comment above stops being true with it.
const api = read('pages/api/service-schedule.ts');
check('a blank schedule row still DELETES (recorded, not assumed)',
  /isBlank\(e\.item, e\)/.test(api) && /serviceScheduleReading\.deleteMany/.test(api),
  'so a form that empties itself can still destroy readings — the seed is the only thing standing in front of it');

const fails = out.filter((c) => c === 'F').length;
console.log(`\n${fails} failures of ${out.length}`);
process.exit(fails ? 1 : 0);
