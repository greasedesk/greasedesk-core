/**
 * File: scripts/dev-restart-gate.mjs
 *
 * THE DEV SUPERVISOR REPLACES ITS SERVER WITHOUT KILLING THE REPLACEMENT.
 *
 * scripts/dev.mjs armed its SIGKILL fallback against the module variable `child`, which held the NEW
 * server by the time the timer fired. The fallback killed the replacement, the supervisor exited, and
 * an orphaned next-server was left answering on the port — twice on 2026-09-17. See scripts/_dev-restart.
 *
 * Driven with FAKE processes and a short grace period: no server is started, nothing touches a port.
 * The instrument is proved first against a copy of the old inline code, so a pass means the defect is
 * absent rather than that the check could not see it.
 */
import './_gate-preflight.mjs';
import { EventEmitter } from 'node:events';
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const { replaceServer } = await import(`${R}/scripts/_dev-restart.mjs`);

/** A process that records the signals it receives; exits on SIGTERM unless wedged, always on SIGKILL. */
const fake = (name, { wedged = false } = {}) => {
  const p = new EventEmitter();
  p.name = name; p.signals = []; p.exited = false;
  p.kill = (sig) => {
    if (p.exited) throw new Error(`${name} is not running`);
    p.signals.push(sig);
    if (sig === 'SIGKILL' || !wedged) { p.exited = true; setImmediate(() => p.emit('exit', null, sig)); }
    return true;
  };
  return p;
};
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const GRACE = 40;

try {
  /**
   * A SUPERVISOR IN MINIATURE, the shape of dev.mjs: one variable for the current server, and a start()
   * that puts a fresh one in it. `restartWith` is the thing under test.
   */
  const supervise = (restartWith) => {
    const s = { child: fake('first'), started: [] };
    // Records whether the server it replaces had ACTUALLY exited at the moment the new one started.
    s.start = () => { s.oldGoneAtStart = s.child.exited; s.child = fake(`server-${s.started.length + 2}`); s.started.push(s.child); };
    s.restart = () => restartWith(s);
    return s;
  };
  const survivors = async (restartWith, wedged = false) => {
    const s = supervise(restartWith);
    if (wedged) s.child = fake('first', { wedged: true });
    const first = s.child;
    s.restart();
    await wait(GRACE * 3);
    return { first, replacement: s.started[0] ?? null, s };
  };

  // THE OLD CODE, verbatim in shape: the fallback reads `s.child` when the timer fires.
  const oldInline = (s) => {
    s.child.once('exit', () => s.start());
    s.child.kill('SIGTERM');
    setTimeout(() => { try { s.child?.kill('SIGKILL'); } catch { /* already gone */ } }, GRACE);
  };
  const viaHelper = (s) => replaceServer(s.child, { onGone: () => s.start(), graceMs: GRACE });

  console.log('— THE INSTRUMENT SEES THE DEFECT —');
  const bad = await survivors(oldInline);
  check('the OLD inline fallback kills the replacement — the defect, reproduced', bad.replacement?.signals.includes('SIGKILL') === true,
    `replacement received ${JSON.stringify(bad.replacement?.signals)}`);

  console.log('\n— THE HELPER —');
  const good = await survivors(viaHelper);
  check('the replacement is started only once the old server HAS exited — never beside it on the port', good.replacement !== null && good.s.oldGoneAtStart === true);
  check('  …and is left ALONE after the grace period — no signal of any kind', good.replacement && good.replacement.signals.length === 0,
    `replacement received ${JSON.stringify(good.replacement?.signals)}`);
  check('  …and the old server was asked politely, once', JSON.stringify(good.first.signals) === '["SIGTERM"]', JSON.stringify(good.first.signals));
  check('exactly one replacement is started', good.s.started.length === 1, `${good.s.started.length}`);

  const wedged = await survivors(viaHelper, true);
  check('a WEDGED old server that ignores SIGTERM is killed after the grace period', JSON.stringify(wedged.first.signals) === '["SIGTERM","SIGKILL"]',
    JSON.stringify(wedged.first.signals));
  check('  …and only then is the replacement started, and left alone', wedged.replacement !== null && wedged.s.oldGoneAtStart === true && wedged.replacement.signals.length === 0);

  let calledNow = false;
  replaceServer(null, { onGone: () => { calledNow = true; }, graceMs: GRACE });
  check('with no server running, the replacement starts at once', calledNow);

  console.log('\n— dev.mjs USES IT —');
  // A SOURCE CHECK, and labelled as one: it proves the wiring, not the behaviour — the behaviour is the
  // clauses above. Comments are stripped so a mention in prose cannot satisfy it.
  const dev = readFileSync(`${R}/scripts/dev.mjs`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('dev.mjs restarts through replaceServer', /replaceServer\(child,/.test(dev) && /from '\.\/_dev-restart\.mjs'/.test(dev));
  check('  …and no longer arms a kill against its own `child` variable', !/child\?\.kill\(\s*'SIGKILL'/.test(dev));
} catch (e) {
  check('run completed', false, String(e?.stack ?? e).slice(0, 300));
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
