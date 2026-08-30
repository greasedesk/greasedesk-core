/**
 * File: scripts/_gate-retry.mjs
 * Retry for gates, with recovery kept VISIBLE.
 *
 * ── WHY A RETRY, AND WHY IT MUST CONFESS ────────────────────────────────────────────────────────
 * Neon drops connections. A gate that aborts mid-run on a P1001 reports a red that means nothing —
 * and the entire discipline this codebase runs on depends on red meaning something. Teardowns
 * already retry for the same reason: a blip must not strand fixtures.
 *
 * But a silent retry is the opposite failure. A gate that is flaky EVERY time and green on the
 * third attempt looks identical to a gate that is solid, and the flakiness then hides behind
 * eventual green until the day the third attempt fails too and nobody knows how long it has been
 * rotten. So recovery is reported: the summary says how many attempts it took, and a run that
 * needed more than one is marked RECOVERED rather than passing quietly.
 *
 * ── ONLY TRANSIENT FAULTS ───────────────────────────────────────────────────────────────────────
 * P1001 (server unreachable), P1017 (connection closed), P2024 (pool timeout) and the raw socket
 * errors underneath them. A failing ASSERTION is never retried — that is the gate doing its job,
 * and re-running until it passes would be the worst tool in this file.
 */

import './_gate-preflight.mjs';
const TRANSIENT_CODES = new Set(['P1001', 'P1017', 'P2024']);
const TRANSIENT_TEXT = /Can't reach database server|Connection closed|connection pool|ECONNRESET|ETIMEDOUT|socket hang up/i;

export const isTransient = (e) => {
  if (!e) return false;
  if (TRANSIENT_CODES.has(e.code)) return true;
  // ── AN INITIALIZATION ERROR IS A CONNECTION NEVER OBTAINED ────────────────────────────────────
  // CORRECTED 30 Aug 2026. This clause was added the day before on a wrong diagnosis, and the
  // commit message that introduced it (d6c047c) says something untrue. Recorded here rather than
  // quietly fixed, because the wrong reason is the part that would have misled the next reader.
  //
  // WHAT I CLAIMED: the errors taking out gates carried no code and no message, so both checks
  // either side of this line missed them and the helper was blind to the only fault that happens.
  //
  // WHAT WAS ACTUALLY TRUE: they carried a full message — "Can't reach database server at
  // <host>:5432" — which TRANSIENT_TEXT already matches. `isTransient` would have returned true
  // for every one of them. The blank reasons came from somewhere else entirely: Prisma's messages
  // BEGIN with a newline, and the suite summary read one line, so the reason landed on line two
  // and was dropped (see _gate-summary.mjs). I mistook a reporting defect for a detection one, and
  // the fix appearing to work was not evidence the diagnosis was right.
  //
  // WHY THE CLAUSE STAYS: it is still correct, just narrower than advertised. A
  // PrismaClientInitializationError with no code IS a connection that could not be obtained —
  // nothing was sent, so anything may be repeated — and it covers the case TRANSIENT_TEXT cannot:
  // a wording the regex does not know. `lib/db` carries the same clause (29 Aug); keep the two
  // identical, and retry-transient-gate pins that they match.
  //
  // Narrow ON PURPOSE. "No code and no message" also describes a bare `new Error()`, and a gate
  // whose assertion throws must fail rather than be retried four times into a green.
  if (e.code == null && e?.constructor?.name === 'PrismaClientInitializationError') return true;
  return TRANSIENT_TEXT.test(String(e.message ?? ''));
};

/**
 * Run `fn`, retrying only transient database faults. Returns { value, attempts }.
 *
 * `onRetry` is called with (attempt, error) so the caller can print it AS IT HAPPENS — a gate that
 * hangs for thirty seconds should say why rather than looking wedged.
 */
export async function withRetry(fn, opts = {}) {
  const max = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1500;
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === max) throw e;
      opts.onRetry?.(attempt, e);
      await new Promise((r) => setTimeout(r, baseMs * attempt));
    }
  }
  throw lastErr;
}

/**
 * A Prisma client that retries transient faults on EVERY query, and counts how often it had to.
 *
 * ── WHY AT THE QUERY, NOT ROUND THE WHOLE GATE ──────────────────────────────────────────────────
 * Re-running a gate body from the top is unsafe here by construction: most gates refuse to start if
 * their own fixtures are present, so a second attempt after a half-completed first one aborts with
 * "REFUSING: leftovers" — a red that is now about the retry rather than the code. And the real
 * fault is always a SINGLE query dying, not the run. Retrying that query lets the gate carry on
 * exactly where it was.
 *
 *   const prisma = retryingPrisma(rawPrisma);
 *
 * `retryCount()` is what makes recovery visible: a gate prints it, so a run that limped to green
 * says so instead of looking identical to a clean one.
 */
export function retryingPrisma(client, opts = {}) {
  let retries = 0;
  // ONE call per invocation. An earlier draft of this ran the query, then ran it again to unwrap
  // the return value — a comma expression that would have doubled every write the gates make.
  // Caught before it ran; noted because a retry helper that silently duplicates writes is the most
  // expensive possible bug in a file whose entire job is to make flaky runs safe.
  const wrapFn = (fn, label) => async (...args) => {
    const { value } = await withRetry(() => fn(...args), {
      ...opts,
      onRetry: (attempt, e) => {
        retries++;
        console.log(`  … ${label}: ${e?.code ?? 'transient fault'} on attempt ${attempt} — retrying`);
      },
    });
    return value;
  };

  return new Proxy(client, {
    get(target, prop) {
      const v = target[prop];
      if (typeof prop === 'string' && prop === '$__retryCount') return () => retries;
      // $transaction and $queryRawUnsafe are functions on the client itself.
      if (typeof v === 'function') return wrapFn(v.bind(target), String(prop));
      // Model delegates: wrap each method lazily.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return new Proxy(v, {
          get(m, mp) {
            const mv = m[mp];
            if (typeof mv === 'function') return wrapFn(mv.bind(m), `${String(prop)}.${String(mp)}`);
            return mv;
          },
        });
      }
      return v;
    },
  });
}

/** How many times the wrapped client had to retry. Zero means the run was clean. */
export const retryCount = (p) => (typeof p.$__retryCount === 'function' ? p.$__retryCount() : 0);

/**
 * Wrap a whole gate body. Prints the verdict, and SAYS SO when it took more than one go.
 *
 * Usage:
 *   await runGate('rolling-12', async () => { ...checks...; return failures; });
 *
 * The body returns the failure count. A thrown transient fault re-runs the body from the top, so
 * the body must be safe to repeat — which for a gate means its own teardown has already run, or it
 * refuses to start on leftovers. Both are house rules already.
 */
export async function runGate(name, body, opts = {}) {
  let attempts = 0;
  try {
    const { value: failures, attempts: n } = await withRetry(async (attempt) => {
      attempts = attempt;
      return body(attempt);
    }, {
      ...opts,
      onRetry: (attempt, e) => {
        console.log(`\n… ${name}: transient database fault on attempt ${attempt} (${e?.code ?? 'no code'}) — retrying`);
      },
    });
    if (attempts > 1) {
      // NOT a clean pass. Green on the second go is a fact about the environment that someone
      // should see, not a detail to swallow.
      console.log(`\n⚠ ${name}: RECOVERED after ${attempts} attempts — green, but the run was not clean.`);
      console.log('  A gate that recovers every time is a flaky gate hiding behind eventual green.');
    }
    return { failures, attempts, recovered: attempts > 1 };
  } catch (e) {
    console.error(`\n✗ ${name}: gave up after ${attempts} attempt(s) — ${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 200)}`);
    return { failures: 1, attempts, recovered: false, fatal: true };
  }
}
