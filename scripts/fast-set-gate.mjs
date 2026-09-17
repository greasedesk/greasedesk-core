/**
 * File: scripts/fast-set-gate.mjs
 *
 * THE FAST SET IS DERIVED FROM MEASUREMENTS, AND ONLY A GREEN RUN IS ONE.
 *
 * The rerun policy runs the fast set while a slice is being built. Its first use was a hand-picked list
 * ("every gate under 2 seconds in this run"), which drifts the moment it exists. scripts/_fast-set derives
 * membership instead; this gate proves the rules on planted runs, then that the runner prints the basis.
 * No database, no server: the runner is asked only to --list.
 */
import './_gate-preflight.mjs';
const { spawnSync } = await import('node:child_process');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const FS = await import(`${R}/scripts/_fast-set.mjs`);

try {
  const tierOf = (g) => (g.startsWith('manual-') ? 'manual' : 'core');
  const at = new Date('2026-09-17T10:00:00Z');
  const green = (gate, seconds) => ({ gate, seconds, code: 0, timedOut: false, unrun: false });

  console.log('— ONLY A GREEN RUN IS A MEASUREMENT —');
  let t = {};
  t = FS.recordTiming(t, green('browser-gate', 38.4), at);
  check('a green run is recorded, with its time and date', t['browser-gate']?.seconds === 38.4 && t['browser-gate']?.measuredAt === at.toISOString());
  const crashed = { gate: 'browser-gate', seconds: 0.4, code: 1, timedOut: false, unrun: false };
  check('a CRASHED run is not a measurement — the slow gate does not become fast by failing early',
    FS.recordTiming(t, crashed, at) === t && t['browser-gate'].seconds === 38.4);
  check('  …nor a timeout', FS.recordTiming(t, { gate: 'browser-gate', seconds: 0.2, code: 124, timedOut: true, unrun: false }, at) === t);
  check('  …nor a decline (UNRUN)', FS.recordTiming(t, { gate: 'browser-gate', seconds: 0.3, code: 4, timedOut: false, unrun: true }, at) === t);
  const onlyCrashed = FS.recordTiming({}, { gate: 'new-browser-gate', seconds: 0.5, code: 1, timedOut: false, unrun: false }, at);
  check('a gate whose only run crashed stays UNMEASURED, not "0.5s"', !('new-browser-gate' in onlyCrashed));

  console.log('\n— MEMBERSHIP —');
  const timings = {
    'scan-gate': { seconds: 0.2, measuredAt: '2026-09-17T09:00:00.000Z' },
    'browser-gate': { seconds: 38.4, measuredAt: '2026-09-17T09:00:00.000Z' },
    'edge-gate': { seconds: 2, measuredAt: '2026-09-17T09:00:00.000Z' },
    'manual-demo-gate': { seconds: 0.1, measuredAt: '2026-09-17T09:00:00.000Z' },
  };
  const set = FS.fastSet(['scan-gate', 'browser-gate', 'edge-gate', 'brand-new-gate', 'manual-demo-gate'], timings, tierOf);
  const by = Object.fromEntries(set.map((d) => [d.gate, d]));
  check('a gate measured under the threshold is IN', by['scan-gate'].member === true);
  check('a slow gate is OUT', by['browser-gate'].member === false);
  check('exactly AT the threshold is OUT — strictly under', by['edge-gate'].member === false, `${FS.FAST_THRESHOLD_S}s threshold`);
  check('an UNMEASURED gate is IN — a new gate has not shown it is slow', by['brand-new-gate'].member === true);
  check('the manual tier is never in, however fast', by['manual-demo-gate'].member === false);
  check('every gate is DECIDED, in or out — nothing is silently absent', set.length === 5);

  const slowedDown = FS.recordTiming({ 'was-fast-gate': { seconds: 0.5, measuredAt: '2026-09-16T09:00:00.000Z' } }, green('was-fast-gate', 6.1), at);
  check('the LATEST green run decides: a gate that slowed down leaves the set', FS.fastSet(['was-fast-gate'], slowedDown, tierOf)[0].member === false);

  console.log('\n— THE BASIS IS PRINTED, NOT TRUSTED —');
  check('a measured gate’s basis names its time and the date measured', by['scan-gate'].basis === '0.2s, measured 2026-09-17', by['scan-gate'].basis);
  check('an unmeasured gate’s basis SAYS unmeasured', /^unmeasured/.test(by['brand-new-gate'].basis), by['brand-new-gate'].basis);
  check('a manual gate’s basis says why it is out', /manual tier, never in the fast set/.test(by['manual-demo-gate'].basis));
  check('the threshold is two seconds, named once', FS.FAST_THRESHOLD_S === 2);

  console.log('\n— THE RUNNER —');
  /**
   * EVERY RUNNER CALL CARRIES --list, and that is load-bearing. The first version asked `--fast --tier core`
   * without it, to prove the pair refuses. Red-proving that refusal DISABLED it — and the runner went on to
   * RUN the fast set, which contains this gate, which asked the runner again: a recursive chain growing every
   * few seconds, running gates concurrently on ZZ, stopped by hand on 2026-09-17. With --list, a broken
   * refusal can only print a plan; nothing this gate asks for can ever execute a gate.
   */
  const run = (args) => spawnSync(process.execPath, ['scripts/gates.mjs', ...args.filter((a) => a !== '--list'), '--list'],
    { cwd: R, encoding: 'utf8', env: { ...process.env, GATE_ALLOW_PIPE: '1' }, timeout: 60_000 });
  const listed = run(['--fast', '--list']);
  const text = `${listed.stdout}${listed.stderr}`;
  check('--fast --list prints the set’s header with the threshold', listed.status === 0 && /FAST SET — \d+ of \d+ gates\. Threshold: under 2s on the latest GREEN run; unmeasured gates are in\./.test(text),
    text.split('\n').find((l) => l.startsWith('FAST SET')) ?? `exit ${listed.status}`);
  const decisions = text.split('\n').filter((l) => /^ {2}(IN |out) \S+/.test(l));
  check('  …and a decision line for EVERY gate, in or out, with its basis', decisions.length > 0 && decisions.every((l) => /(unmeasured|s, measured \d{4}-\d{2}-\d{2})/.test(l)),
    `${decisions.length} lines`);
  check('  …the manual demo generator is out, whatever its time', decisions.some((l) => /^ {2}out demo-generation-gate\s/.test(l)));
  const both = run(['--fast', '--tier', 'core', '--list']);
  check('--fast with --tier refuses — the fast set spans every tier', both.status === 2 && /--fast and --tier together/.test(`${both.stdout}${both.stderr}`));
  // A SOURCE CHECK, labelled as one: the runner cannot be run for real here (it would run gates). It proves
  // the wiring — that each gate's result is offered to recordTiming and the file written — not the rules,
  // which are the clauses above. Comments are stripped so prose cannot satisfy it.
  const src = readFileSync(`${R}/scripts/gates.mjs`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the runner offers every result to recordTiming and writes the timings file',
    /recordTiming\(current, results\[g\]\)/.test(src) && /writeFileSync\(TIMINGS,/.test(src));
  check('  …and --fast derives the plan from fastSet, not from a list', /const decided = fastSet\(gates, timings, tierOf\)/.test(src) && /plan = inSet\.map/.test(src));
  check('the timings file is gitignored — a fact about this machine', readFileSync(`${R}/.gitignore`, 'utf8').split('\n').includes('.gate-timings.json'));
} catch (e) {
  check('run completed', false, String(e?.stack ?? e).slice(0, 300));
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
