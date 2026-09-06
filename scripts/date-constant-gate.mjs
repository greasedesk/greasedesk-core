/**
 * File: scripts/date-constant-gate.mjs
 * A GATE MUST NOT CHANGE ANSWER BECAUSE OF THE DAY IT RAN.
 * @gate-requires: none
 *
 * ── FIVE IN ONE DAY ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-06 surfaced five gates whose result depended on the calendar rather than the code:
 *   counter-payment   a fixed day-of-month as the paid date — future for the first 11 days of every
 *                     month, so the handler refused it and the gate reported a broken ledger
 *   trial-control     "Extends by 30 days" asserted as a literal; a 30-day span resolved to end of
 *                     day rounds to 31 in the morning and 30 in the afternoon
 *   rolling-12        required the CURRENT month to contain revenue
 *   mot-refresh       pins a real DVSA expiry that moves when the car is next tested
 *   service-schedule  pins an MOT date that will cross a band
 *
 * Three of the five were mine, written the same week as the note saying not to do this. That is the
 * argument for a scan rather than a rule: a rule I keep failing to follow is a process I have not
 * built yet.
 *
 * ── WHAT IS BANNED, AND WHAT DELIBERATELY IS NOT ────────────────────────────────────────────────
 * A. A FIXED DAY-OF-MONTH ON A CLOCK-DERIVED MONTH — `Date.UTC(x.getUTCFullYear(),
 *    x.getUTCMonth(), <n>)` for n ≥ 2. Day 1 is allowed: the first of the current month is never
 *    ahead of the clock, which is why every month-bucket boundary in the suite uses it.
 * B. A LITERAL DAY-COUNT IN A REGEX ASSERTION — /Extends by 30 days/. The number is only right
 *    while the clock agrees with it; derive it and interpolate, as trial-control now does.
 *
 * A FIXED CLOCK IS NOT BANNED and must not be. commission-fixed-clock-gate pins 78 dates on
 * purpose, and pinning `now` is the CURE for this class, not the disease — what makes a date
 * dangerous is being compared against the real clock, not being written down.
 *
 * ── IT READS CODE, NOT COMMENTS ─────────────────────────────────────────────────────────────────
 * Every file goes through prose() first. Otherwise the paragraph above — which necessarily contains
 * "Extends by 30 days" — would trip the ban it describes, and so would the note trial-control now
 * carries explaining why its literal went. A file must be able to say what it no longer does.
 *
 * This gate is excluded from its own sweep for the same reason, and the synthetic cases below are
 * what prove the scanner still sees a real one.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
const { readFileSync, readdirSync } = await import('node:fs');

const SELF = 'date-constant-gate.mjs';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
/** CODE ONLY. A comment explaining a banned shape is not the banned shape. */
const prose = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

/** A: a literal day-of-month ≥ 2 built onto a month taken from the clock. */
const FIXED_DAY = /Date\.UTC\(\s*[\w.]*getUTCFullYear\(\)\s*,\s*[\w.]*getUTCMonth\(\)[^,]*,\s*(\d+)\s*[),]/g;
/** B: a day-count written into a regex literal, which only matches while the clock agrees. */
const LITERAL_DAYS = /\/[^/\n]*\b\d+\s+days?\b[^/\n]*\//g;

/** Every offence in one file's CODE. Exported so the synthetic cases below test the real scanner. */
export function dateConstantOffences(src) {
  const code = prose(src);
  const hits = [];
  for (const m of code.matchAll(FIXED_DAY)) {
    if (Number(m[1]) >= 2) hits.push(`fixed day-of-month ${m[1]} on a clock-derived month`);
  }
  // B only bites where the wall clock is actually read; a gate on a pinned clock may say "30 days".
  if (/new Date\(\)|Date\.now\(\)/.test(code)) {
    for (const line of code.split('\n')) {
      for (const m of line.matchAll(LITERAL_DAYS)) {
        const n = /\b(\d+)\s+days?\b/.exec(m[0])?.[1];
        // THE NUMBER'S PROVENANCE MUST BE VISIBLE. If the same figure appears on the line as an
        // INPUT — `/62 days ago/.test(leadStack({ motDays: -62 }, NOW))` — the assertion is
        // anchored to something the reader can see, and the clock is not what decides it. What is
        // banned is a MAGIC number: `/Extends by 30 days/` beside a value derived from `now`,
        // where nothing on the line says where 30 came from.
        if (n && new RegExp(`(?<![\\d.])-?${n}(?![\\d.])`).test(line.replace(m[0], ''))) continue;
        hits.push(`literal day-count in a regex: ${m[0].slice(0, 46)}`);
      }
    }
  }
  return hits;
}

// ── IMPORTABLE, NOT JUST RUNNABLE ──────────────────────────────────────────────────────────────
// The checks below run only when this file IS the command. Importing it to reuse the scanner —
// which is how the two historical gates were red-proved — otherwise executes the whole gate and
// process.exit()s before the caller prints anything. A scanner worth trusting is one you can point
// at a file that is not in the tree any more.
const isMain = process.argv[1] && process.argv[1].endsWith(SELF);
if (isMain) try {
  // ── 1. THE SCANNER SEES A REAL ONE ───────────────────────────────────────────────────────────
  // Proven on synthetic sources, because a sweep that finds nothing is indistinguishable from a
  // scanner that cannot find anything.
  console.log('\n— proven on synthetic sources —');
  const A_BAD = 'const now = new Date();\nconst d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12));';
  const A_OK = 'const now = new Date();\nconst d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));';
  const A_CLAMPED = 'const now = new Date();\nconst d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(12, now.getUTCDate() - 1)));';
  check('a fixed day-of-month on a clock-derived month is FLAGGED', dateConstantOffences(A_BAD).length === 1, A_BAD.slice(-46));
  check('  …but the first of the month is not', dateConstantOffences(A_OK).length === 0,
    'the 1st is never ahead of the clock — every month boundary in the suite uses it');
  check('  …and neither is a clamped day', dateConstantOffences(A_CLAMPED).length === 0,
    'no bare literal reaches the day slot');
  const B_BAD = 'const now = new Date();\ncheck(\'x\', /Extends by 30 days/.test(t));';
  const B_OK = 'const now = new Date();\ncheck(\'x\', new RegExp(`Extends by ${d} days`).test(t));';
  const B_FIXED = 'const NOW = new Date(\'2026-08-29\');\ncheck(\'x\', /Extends by 30 days/.test(t));';
  check('a literal day-count in a regex is FLAGGED', dateConstantOffences(B_BAD).length === 1, B_BAD.slice(-34));
  check('  …but a derived one is not', dateConstantOffences(B_OK).length === 0, 'interpolated from the rule');
  check('  …and a gate on a PINNED clock may say it', dateConstantOffences(B_FIXED).length === 0,
    'a fixed clock is the cure for this class, not the disease');
  // THE FALSE POSITIVE THIS RULE WAS NARROWED BY. marketing-board asserts /62 days ago/ against a
  // pure function called with motDays: -62 and a pinned NOW — the figure is an INPUT on the line,
  // not a guess about today.
  const B_ANCHORED = 'const now = new Date();\ncheck(\'x\', /62 days ago/.test(stack({ motDays: -62 }, NOW).text));';
  check('  …and a day-count anchored to a visible input is not', dateConstantOffences(B_ANCHORED).length === 0,
    'the number appears on the line as an input, so the clock is not what decides it');
  const B_MAGIC = 'const now = new Date();\nconst t = now.getTime();\ncheck(\'x\', /Extends by 30 days/.test(preview));';
  check('  …while a magic one still is', dateConstantOffences(B_MAGIC).length === 1,
    'nothing on the line says where 30 came from');
  check('a comment describing the ban does not trip it',
    dateConstantOffences('// Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12) is banned\nconst x = 1;').length === 0,
    'prose() first — a file must be able to say what it no longer does');

  // ── 2. THE SWEEP ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— and no gate in the suite carries one —');
  const files = readdirSync('scripts').filter((f) => f.endsWith('-gate.mjs') && f !== SELF);
  const offenders = [];
  for (const f of files) {
    const hits = dateConstantOffences(readFileSync(`scripts/${f}`, 'utf8'));
    if (hits.length) offenders.push(`${f}: ${hits.join('; ')}`);
  }
  check('no gate pins a date constant against the wall clock', offenders.length === 0, offenders.join('\n    ') || `${files.length} gates clean`);
  check('  …and the sweep really covered the suite', files.length >= 100, `${files.length} gates`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
}

if (isMain) {
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  process.exit(out.includes('F') ? 1 : 0);
}
