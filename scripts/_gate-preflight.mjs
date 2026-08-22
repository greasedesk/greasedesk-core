/**
 * File: scripts/_gate-preflight.mjs
 * Refuse to start a gate whose stdout is a pipe. Import on line one, before anything else.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Gates write fixtures to a REAL tenant and remove them in a `finally`. Piping one to `head` kills
 * the process the moment the reader closes — part-way through the run, before the finally. The
 * fixture stays on the tenant.
 *
 * That has now happened twice. The second time the lesson was already written down: a `| head -14`
 * on refund-surfaces-gate left a fixture refund on ZZ 0029 and an invoice cache reading 27000
 * against a real 12000. Writing it down did not work, because the note lived somewhere nobody was
 * looking at the moment the pipe got typed — the same shape as a stale comment. So it is enforced
 * here instead. Prose asks; structure enforces.
 *
 * ── WHAT COUNTS AS DANGEROUS ────────────────────────────────────────────────────────────────────
 * A FIFO on fd 1, and only that. A terminal is fine (nothing truncates it). `> run.log` is fine —
 * a regular file takes every byte. `| head`, `| grep`, `| tee`, `2>&1 | less` are all FIFOs and all
 * refused. Read the log file afterwards; that is the whole workaround, and it is a better one.
 *
 * ── THE ESCAPE ──────────────────────────────────────────────────────────────────────────────────
 * GATE_ALLOW_PIPE=1. For CI, which legitimately captures through a pipe. It is not a silent
 * allowance: with it set, an EPIPE on stdout is reported LOUDLY on stderr, because a run that died
 * mid-teardown must never look like a run that finished.
 *
 * ── WHY IT REFUSES INSTEAD OF RECOVERING ────────────────────────────────────────────────────────
 * EPIPE arrives after the damage, mid-teardown, with the process already dying and no reliable
 * point to recover from. Refusing up front costs nothing and is unambiguous.
 *
 * ── AND WHY EVERY GATE IMPORTS IT EXPLICITLY ────────────────────────────────────────────────────
 * Structure a gate cannot run without gets adopted; structure it merely ought to use does not.
 * That is why `_ts.mjs` is universal and the written-down lesson was not. This module is weaker
 * than `_ts.mjs` on that test — a gate still runs if the line is missing — so the line was added to
 * all 29 gates at once, and `_ts.mjs` and `_gate-retry.mjs` both chain to it. A new gate is written
 * by copying an existing one, which is the mechanism that actually carries a convention forward.
 */
import { fstatSync } from 'node:fs';

// Idempotent: three entry points chain here and a gate may import it directly.
if (!globalThis.__gatePreflightRan) {
  globalThis.__gatePreflightRan = true;

  const allowed = process.env.GATE_ALLOW_PIPE === '1' || process.env.GATE_ALLOW_PIPE === 'yes';

  /** A pipe on fd 1. Terminals and regular files are safe; a closed fd 1 is not. */
  const stdoutIsPipe = () => {
    if (process.stdout.isTTY) return false;
    try {
      return fstatSync(1).isFIFO();
    } catch {
      return true; // cannot stat fd 1 — output has nowhere safe to go. Treat as dangerous.
    }
  };

  if (stdoutIsPipe() && !allowed) {
    const name = process.argv[1]?.split('/').pop() ?? 'this gate';
    // stderr, NOT stdout: the whole problem is that stdout goes somewhere that stops reading.
    process.stderr.write(
      `\nREFUSING TO RUN — ${name}'s stdout is a pipe.\n\n` +
      `  A gate writes fixtures to a real tenant and removes them in a finally block. If the\n` +
      `  reader closes early (head, grep -m, less, a killed pager) this process dies part-way\n` +
      `  through and THE FIXTURES STAY ON THE TENANT. That has happened twice; the last one left\n` +
      `  a fixture refund on a live invoice reading 27000 against a real 12000.\n\n` +
      `  Do this instead:\n` +
      `      node ${process.argv[1] ?? 'scripts/<name>-gate.mjs'} > /tmp/gate.log 2>&1; echo $?\n` +
      `      grep -E '^(✗|[0-9]+ failures)' /tmp/gate.log\n\n` +
      `  If you genuinely need a pipe (CI capture), set GATE_ALLOW_PIPE=1. A truncated run will\n` +
      `  then be reported on stderr rather than passing silently.\n\n`,
    );
    process.exit(2); // 2 = refused to start. A gate FAILURE is 1; the two must not look alike.
  }

  if (allowed) {
    // Permitted, not trusted. If the reader does close early, say so where it can still be seen.
    process.stdout.on('error', (e) => {
      if (e?.code !== 'EPIPE') return;
      try {
        process.stderr.write(
          '\nEPIPE ON STDOUT — the reader closed early and this run was TRUNCATED.\n' +
          '  Teardown may not have completed. Check the tenant for leftover fixtures before\n' +
          '  trusting anything above. (GATE_ALLOW_PIPE was set, so the pipe was permitted.)\n',
        );
      } catch { /* stderr is gone too; nothing left to report with */ }
    });
  }
}

/**
 * ── A SELECTOR TIMEOUT MIGHT BE THE STALE-CLIENT GUARD ──────────────────────────────────────────
 * lib/client-freshness makes a stale dev-server client say so ON THE PAGE. A gate driving Chrome
 * with waitForSelector never reads that page: it waits for an element the error page does not have
 * and reports a bare timeout — which is exactly the wrong-diagnosis problem the guard exists to
 * stop, moved one level out. So a gate that fails can ask, and be told.
 *
 * Exported rather than automatic: it costs a fetch, and only browser-driving gates need it.
 */
export async function explainIfClientStale(base = process.env.GATE_BASE ?? 'http://localhost:3000') {
  try {
    const r = await fetch(`${base}/c/aaaaaaaaaaaaaaaa`);
    const t = await r.text();
    if (/OLD PRISMA CLIENT|RESTART THE DEV SERVER/i.test(t)) {
      console.log('\n  ⚠  THE DEV SERVER IS RUNNING AN OLD PRISMA CLIENT — restart it and re-run.');
      console.log('     (This failure is almost certainly that, not the thing being tested.)\n');
      return true;
    }
  } catch { /* the server being down is a different problem, and its own error says so */ }
  return false;
}

// ── WHICH SITE IS ZZ'S ───────────────────────────────────────────────────────────────────────────

/**
 * ZZ Gate Garage, the tenant. The GROUP id is pinned because it is the tenant's identity and every
 * gate already pins it. The SITE id deliberately is not: see zzSite below.
 */
export const ZZ_GROUP = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';

/**
 * When this process began. The discriminator between a live fixture and a leak — see zzSite.
 * Captured at module load, which for every gate is its first import.
 */
const PROCESS_START = new Date();

/**
 * Clock skew allowance between this machine and Neon. `created_at` is the DATABASE's now(), and it
 * is compared against a timestamp taken here; a site created seconds before this process started is
 * treated as in-flight rather than leaked. It only blunts detection of leaks under a minute old,
 * which are the ones least likely to be leaks at all.
 */
const SKEW_MS = 60_000;

/**
 * ZZ'S CANONICAL SITE — resolved, never pinned, and refusing when the tenant is not clean.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Twenty-two gates used to open with `site.findFirst({ where: { group_id: ZZ } })`. That is not a
 * lookup, it is a coin toss the moment ZZ holds more than one site — and ZZ legitimately holds more
 * than one whenever a site-creating gate is mid-run, or permanently once one of them leaks. A
 * leaked fixture site did exactly that on 2026-08-22: `intake-prompts-gate` read its switches and
 * found them ON, `no-show-gate` got a site with no bay and silently wrote a booking with no slot,
 * and both failed on assertions describing something else entirely. Neither named the real cause.
 *
 * ── HOW IT IDENTIFIES THE CANONICAL SITE ────────────────────────────────────────────────────────
 * Through `User.primary_site_id` on ZZ's owner. Not a pinned uuid, which would be a second place to
 * update and would go quietly wrong against a rebuilt tenant; not the site NAME, because a name is
 * exactly what a leaked duplicate shares with the live fixture it came from. `primary_site_id` is
 * the product's own answer to "which site is this person's", it survives a rename, and it is what
 * getVisibility already reports as primarySiteId.
 *
 * ── HOW IT TELLS A LIVE FIXTURE FROM A LEAK ─────────────────────────────────────────────────────
 * By AGE, not by name. Five gates legitimately create their own ZZ sites — 'ZZ Oil Prompt Site',
 * 'ZZ Timing Fixture Site', 'ZZ Escalation Site', 'ZZ Gate — drift fixture', 'ZZ Offer Site' and
 * 'ZZ Offer Site Two' — and an allow-list of those names could not work, because a LEAKED site
 * carries the same name as the live one it failed to become. What separates them is when they were
 * made: a fixture of the currently-running gate was created after this process started, and
 * anything older is by definition somebody else's residue. The runner is sequential, so during a
 * gate's run its own fixtures are the only ones in flight.
 *
 * A site created after PROCESS_START by a CONCURRENT process is allowed through rather than
 * flagged. That is the safe direction — a false refusal would red a gate that is doing nothing
 * wrong — and it is the reason not to run gates alongside the runner, which is how the leak this
 * guards against was made in the first place.
 *
 * ── THE COST, STATED ────────────────────────────────────────────────────────────────────────────
 * One leak reds twenty-two gates rather than one. That is the intent: a leaked site is a broken
 * environment, not a failing assertion, and twenty-two gates naming the same site in the same
 * sentence is a better morning than one arbitrary gate failing on something unrelated.
 */
export async function zzSite(prisma) {
  const owner = await prisma.user.findFirst({
    where: { group_id: ZZ_GROUP, is_owner: true },
    select: { email: true, primary_site_id: true },
  });
  if (!owner) {
    throw new Error('zzSite: ZZ Gate Garage has no owner — the tenant this gate needs is not set up.');
  }
  if (!owner.primary_site_id) {
    throw new Error(`zzSite: ZZ's owner (${owner.email}) has no primary_site_id, which is what identifies the canonical site. Set it and re-run.`);
  }
  const sites = await prisma.site.findMany({
    where: { group_id: ZZ_GROUP },
    select: { id: true, site_name: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });
  const canonical = sites.find((s) => s.id === owner.primary_site_id);
  if (!canonical) {
    throw new Error(`zzSite: ZZ's owner points at site ${owner.primary_site_id}, which is not one of ZZ's ${sites.length} site(s).`);
  }
  const cutoff = new Date(PROCESS_START.getTime() - SKEW_MS);
  const leaked = sites.filter((s) => s.id !== canonical.id && s.created_at < cutoff);
  if (leaked.length) {
    const lines = leaked.map((s) => `    ${s.id}  ${s.created_at.toISOString()}  "${s.site_name}"`).join('\n');
    throw new Error(
      `zzSite: ZZ holds ${leaked.length} site(s) that are neither canonical nor this run's fixtures:\n${lines}\n`
      + `  Each was created before this process started, so it is residue from a gate that did not tear down.\n`
      + `  A gate picking one of these reads the wrong switches and the wrong bays, and fails somewhere else.\n`
      + `  Clear them (rows that reference them FIRST) and re-run. Canonical is ${canonical.id} "${canonical.site_name}".`,
    );
  }
  return { id: canonical.id };
}
