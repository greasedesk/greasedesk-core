/**
 * File: scripts/dev.mjs
 * `next dev`, SUPERVISED — so the dev server can never outlive the Prisma client it loaded.
 *
 * ── THE FAILURE THIS ENDS ───────────────────────────────────────────────────────────────────────
 * `prisma generate` writes a new client into node_modules. Next does NOT watch node_modules, so a
 * server started before that keeps the old client in memory for ever. lib/db then refuses every
 * query, and NextAuth reports any throw inside authorize() as InvalidCredentials — so it presents
 * as a wrong password, or a 500, or a panel that renders empty. Never as what it is.
 *
 * lib/client-freshness's header records seven or eight interruptions from this, and twice sending
 * an investigation into the wrong subsystem. It happened three more times on 2026-09-06, to someone
 * who had read that header the same day. A rule that keeps being forgotten is not a habit problem;
 * it is a missing process.
 *
 * So: watch the generated client, and when it changes, restart the server. The detector and the
 * runner refusal (lib/client-freshness, scripts/gates.mjs) stay as the belt — this is the braces,
 * and the only one of the three that makes the state impossible rather than legible.
 *
 * ── WHY THE DIRECTORY AND NOT THE FILE ──────────────────────────────────────────────────────────
 * `generate` REPLACES schema.prisma rather than writing through it, so a watcher bound to the file
 * follows the old inode and goes silent. Watching the directory survives that.
 *
 * ── AND WHY CONTENTS, NOT A FINGERPRINT ─────────────────────────────────────────────────────────
 * lib/client-freshness computes a fingerprint for its own purpose. Recomputing it here would be a
 * second implementation of one rule, and the two would drift the first time either changed. This
 * only needs "did these bytes change", so it compares the bytes.
 */
import { spawn } from 'node:child_process';
import { watch, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLIENT_DIR = path.join(ROOT, 'node_modules', '.prisma', 'client');
const SCHEMA_COPY = path.join(CLIENT_DIR, 'schema.prisma');
import { DEV_PORT } from './_dev-port.mjs';

const args = process.argv.slice(2);

/**
 * ── THE PORT SOMEBODY ELSE OWNS ─────────────────────────────────────────────────────────────────
 * SugaVault runs on 3000 on this machine. GreaseDesk must never take it — not because a clash would be
 * noisy, but because it would be QUIET: whichever starts second either fails or, worse, succeeds while
 * the other is stopped, and then two suites drive whichever application answers.
 *
 * ── WHY THIS GUARD EXISTS AT ALL, WHEN THE RULE BELOW IS CORRECT ────────────────────────────────
 * The deference rule underneath says an explicit `--port` wins, because "`npm run dev -- --port 3999`
 * is a decision". That rule is right and its ASSUMPTION was wrong: it assumed only a person passes a
 * port. On 2026-09-13 the desktop harness was measured invoking `npm run dev -p 3000` — it reads
 * .claude/launch.json for the command and supplies the port from its own default, ignoring the
 * `"port": 3010` in that same file. dev.mjs then read a machine's default as a human's choice and
 * stood aside, three times, and GreaseDesk came up on SugaVault's port.
 *
 * So the deference stays for every other port — 3999 really is a decision — and 3000 alone is refused.
 * The one port on this machine that nobody may choose, however deliberately, because the reason has
 * nothing to do with this project.
 *
 * IF SUGAVAULT EVER MOVES, this guard moves with it. It is a fact about the machine, not about Next.
 */
const FORBIDDEN_PORT = 3000;

function explicitPort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') return Number(argv[i + 1]);
    // `--port=3000`, and also the JOINED form `"-p 3000"` arriving as ONE argument. That last shape
    // is not hypothetical: it is what a caller produces when it builds the command as a string, and
    // `next dev` accepts it. A guard that only knows the tidy spellings is a guard with a gap the
    // shape of whatever the next tool happens to do.
    const m = /^(?:--port|-p)[=\s]+(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return null;
}

const asked = explicitPort(args);
if (asked === FORBIDDEN_PORT) {
  console.error(`
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  REFUSING TO START GREASEDESK ON PORT ${FORBIDDEN_PORT}.                             │
  └───────────────────────────────────────────────────────────────────────────┘

  SugaVault owns ${FORBIDDEN_PORT} on this machine. GreaseDesk on it is not a clash you would
  notice — it is two applications taking turns on one address, and a suite that
  cannot tell which one answered. That cost a day and a half once already.

  This is the ONE port that is refused however deliberately it is asked for. Every
  other explicit --port is still honoured: \`npm run dev -- --port 3999\` is a decision.

  IF THIS CAME FROM A TOOL RATHER THAN FROM YOU: the desktop preview harness passes
  \`-p ${FORBIDDEN_PORT}\` of its own accord, ignoring the "port" in .claude/launch.json. Start the
  server with \`npm run dev\` and it uses ${DEV_PORT}, which is what every gate expects.
`);
  process.exit(1);
}

const read = () => (existsSync(SCHEMA_COPY) ? readFileSync(SCHEMA_COPY, 'utf8') : null);
let loaded = read();
let child = null;
let restarting = false;
let stopping = false;

function start() {
  loaded = read(); // the bytes THIS server process is about to load
  // --port EXPLICITLY, and never a fallback. `next dev` with no port picks 3000 and SILENTLY WALKS
  // when it is taken; that silence is what let two gates drive another application for a day and a
  // half. Passed here, a clash is an error somebody reads instead of a move nobody notices.
  // An explicit --port on the command line still wins: `npm run dev -- --port 3999` is a decision —
  // except 3000, refused above, because that one is not this project's to choose.
  // THROUGH THE SAME PARSER AS THE GUARD, and that is the fix for a real hole. This used to be
  // `args.includes('--port') || args.includes('-p')`, which recognises `-p 3000` but NOT `-p=3000` —
  // so an equals-form port was not seen as explicit, DEV_PORT was appended as well, and `next dev`
  // honoured the last flag. Two ports on one command line, the wrong one winning, and nothing saying
  // so. One parser now answers both questions: is a port asked for, and which.
  const port = explicitPort(args) === null ? ['--port', String(DEV_PORT)] : [];
  child = spawn('npx', ['next', 'dev', ...port, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || restarting) return;
    // A crash or a deliberate stop is the developer's business, not ours to paper over.
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function restart(why) {
  if (restarting || stopping) return;
  restarting = true;
  console.log(`\n  [dev] ${why} — restarting next dev so it loads the new client.\n`);
  const done = () => { restarting = false; start(); };
  if (!child) return done();
  child.once('exit', done);
  child.kill('SIGTERM');
  // A server wedged mid-compile does not always take SIGTERM; do not leave a half-dead process
  // holding port 3000, because the next thing anyone sees is "port in use" and a fresh hunt.
  setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } }, 4000);
}

start();

if (existsSync(CLIENT_DIR)) {
  let timer = null;
  watch(CLIENT_DIR, () => {
    // DEBOUNCED: `generate` writes many files, and each one fires. Restarting on the first would
    // race the generator and load a half-written client — the failure this exists to prevent,
    // arrived at from the other side.
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = read();
      if (now !== null && now !== loaded) restart('the Prisma client changed on disk');
    }, 400);
  });
} else {
  console.log('  [dev] node_modules/.prisma/client is not there yet — run `npx prisma generate`.');
  console.log('  [dev] Not watching, so a regenerate will NOT restart the server until dev is rerun.\n');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; try { child?.kill(sig); } catch { /* already gone */ } process.exit(0); });
}
