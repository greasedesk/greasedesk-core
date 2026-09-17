/**
 * File: scripts/_dev-restart.mjs
 * REPLACE THE DEV SERVER — stop the old one, and only then start the new one.
 *
 * ── THE DEFECT THIS EXISTS FOR (2026-09-17) ─────────────────────────────────────────────────────
 * scripts/dev.mjs used to arm its "SIGKILL if SIGTERM did not take" fallback as
 * `setTimeout(() => child?.kill('SIGKILL'), 4000)`. `child` is a module variable — and by the time the
 * timer fired, the old server had exited and `start()` had put the NEW server in it. So the fallback
 * killed the replacement, the supervisor saw its child die and exited, and the new server's own
 * next-server process was left orphaned: answering on the port, supervised by nothing, and one
 * `prisma generate` away from the stale-client confusion dev.mjs exists to end. It happened twice in
 * one day.
 *
 * The fallback now holds the process it was armed FOR. Here, in a module with no side effects, so
 * dev-restart-gate can drive it with fake processes instead of starting real servers.
 */

/**
 * @param {import('node:child_process').ChildProcess | null} old  the server being replaced
 * @param {{ onGone: () => void, graceMs?: number }} o          onGone starts the replacement
 */
export function replaceServer(old, { onGone, graceMs = 4000 }) {
  if (!old) { onGone(); return; }
  let gone = false;
  old.once('exit', () => { gone = true; clearTimeout(fallback); onGone(); });
  old.kill('SIGTERM');
  // A server wedged mid-compile does not always take SIGTERM; do not leave it holding the port. The
  // timer is bound to `old` — never to whatever the caller's variable holds when it fires.
  const fallback = setTimeout(() => { if (!gone) { try { old.kill('SIGKILL'); } catch { /* already gone */ } } }, graceMs);
}
