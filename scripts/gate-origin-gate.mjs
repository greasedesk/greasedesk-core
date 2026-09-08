/**
 * File: scripts/gate-origin-gate.mjs
 * A GATE MUST NOT DECIDE FOR ITSELF WHERE THE SERVER IS.
 * @gate-requires: none
 *
 * ── A DAY AND A HALF TESTING SOMETHING ELSE ─────────────────────────────────────────────────────
 * `process.env.GATE_BASE ?? 'http://localhost:3000'` was written out forty-five times, once per
 * gate, and worked forty-five times because everyone copied it correctly. Two gates spelled the
 * origin their own way — `const ER = 'http://er.greasedesk.com:3000'` — and when another project
 * took port 3000 on this machine, GATE_BASE moved the forty-five and left those two driving the
 * other application. They reported reds for a day and a half. They were not reds: they were a suite
 * testing something else and saying nothing about GreaseDesk.
 *
 * The origin now lives in _gate-preflight (gateOrigin / erOrigin). This gate is what stops the
 * copied idiom coming back — and a copy is exactly what it would be, because the idiom LOOKS
 * harmless and reads as self-contained.
 */
import './_gate-preflight.mjs';
const { gateOrigin, erOrigin } = await import('./_gate-preflight.mjs');
const { readFileSync, readdirSync } = await import('node:fs');

const SELF = 'gate-origin-gate.mjs';
const SOURCE = '_gate-preflight.mjs';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
/** CODE ONLY. A comment quoting the banned literal is not the banned literal. */
const s0 = readFileSync('scripts/gate-origin-gate.mjs', 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Every origin a file spells out for itself. Exported so the synthetic cases test the real scan. */
export function ownOrigins(src) {
  const s = code(src);
  return [
    ...[...s.matchAll(/'https?:\/\/[a-z0-9.-]*:\d{4}'/g)].map((m) => m[0]),
    ...[...s.matchAll(/GATE_BASE\s*\?\?/g)].map(() => 'GATE_BASE ?? …'),
  ];
}

// ── 1. THE SCAN BITES ──────────────────────────────────────────────────────────────────────────
console.log('\n— proven on synthetic sources —');
check('a hardcoded origin is FLAGGED', ownOrigins("const B = 'http://localhost:3000';").length === 1);
check('  …including an er. one', ownOrigins("const ER = 'http://er.greasedesk.com:3000';").length === 1,
    'the exact literal that spent a day and a half driving another application');
check('  …and the copied fallback idiom', ownOrigins("const B = process.env.GATE_BASE ?? 'http://x:3000';").length === 2,
    'both halves: the env read AND the literal behind it');
check('the helper call is not', ownOrigins('const B = gateOrigin();').length === 0);
check('  …nor is a comment quoting the ban',
  ownOrigins("// never write process.env.GATE_BASE ?? 'http://localhost:3000'\nconst B = gateOrigin();").length === 0,
  'a file must be able to say what it no longer does');
check('a port with no origin around it is not flagged', ownOrigins('const timeout = 3000;').length === 0,
  'otherwise every timeout in the suite reads as a hostname');

// ── 2. THE SWEEP ───────────────────────────────────────────────────────────────────────────────
console.log('\n— and no gate spells one out —');
/**
 * ONE EXEMPTION, NAMED, WITH ITS REASON — the runner. gates.mjs must know the origin BEFORE any
 * gate loads, and it cannot import _gate-preflight to find out: that module refuses to load when
 * stdout is a pipe (the fixture-safety guard), which is exactly how the runner is invoked. So it
 * mirrors the literal, and the check below asserts the mirror AGREES rather than exempting it from
 * scrutiny. An exemption that only excuses is how the second copy drifts.
 */
const MIRROR = 'gates.mjs';
const files = readdirSync('scripts').filter((f) => f.endsWith('.mjs') && f !== SELF && f !== SOURCE && f !== MIRROR);
const offenders = [];
for (const f of files) {
  const hits = ownOrigins(readFileSync(`scripts/${f}`, 'utf8'));
  if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check('every gate asks _gate-preflight where the server is', offenders.length === 0,
  offenders.join('\n    ') || `${files.length} gates, none carrying its own`);
check('  …and the sweep really covered the suite', files.length >= 100, `${files.length} files`);

// THE MIRROR, CHECKED RATHER THAN EXCUSED. If the runner and _gate-preflight ever disagree about
// where the server is, every gate talks to one place and the identity check guards another — which
// is the failure this whole slice exists to stop, arriving from the inside.
const runnerSrc = readFileSync(`scripts/${MIRROR}`, 'utf8');
const runnerLit = (runnerSrc.match(/const ORIGIN = ([^;]+);/) ?? [])[1];
const sourceLit = (readFileSync(`scripts/${SOURCE}`, 'utf8').match(/export function gateOrigin\(\) \{\s*return ([^;]+);/) ?? [])[1];
check('the runner mirrors gateOrigin exactly', runnerLit != null && runnerLit.trim() === (sourceLit ?? '').trim(),
  `runner: ${runnerLit} | source: ${sourceLit}`);
check('  …and says why it cannot import it', /refuses to load when|stdout is a pipe/.test(runnerSrc + s0),
  'an exemption with no reason is one somebody deletes');

// ── 3. THE SOURCE ITSELF ───────────────────────────────────────────────────────────────────────
console.log('\n— one env var moves everything —');
check('gateOrigin and erOrigin agree on the port', new URL(erOrigin()).port === new URL(gateOrigin()).port,
  `${gateOrigin()} / ${erOrigin()}`);
check('  …and differ only in the host', new URL(erOrigin()).hostname === 'er.greasedesk.com'
  && new URL(gateOrigin()).hostname !== 'er.greasedesk.com',
  'the hostname is what middleware.ts routes on; the port is what GATE_BASE moves');
check('the resolver rule lives beside the origin it serves',
  /er\.greasedesk\.com 127\.0\.0\.1/.test(readFileSync(`scripts/${SOURCE}`, 'utf8')),
  'a host that resolves nowhere is a gate that 404s for a reason nobody reads');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
