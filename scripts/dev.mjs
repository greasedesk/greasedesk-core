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
const args = process.argv.slice(2);

const read = () => (existsSync(SCHEMA_COPY) ? readFileSync(SCHEMA_COPY, 'utf8') : null);
let loaded = read();
let child = null;
let restarting = false;
let stopping = false;

function start() {
  loaded = read(); // the bytes THIS server process is about to load
  child = spawn('npx', ['next', 'dev', ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
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
