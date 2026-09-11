/**
 * File: scripts/gates.mjs
 * THE GATE RUNNER. One command that runs every gate in the repo and says what is actually red.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * There were 70 gates and no runner. Every sweep was a hand-written list of about twenty, so a gate
 * not on somebody's list was a gate nobody ran — and intake-prompts-gate sat red for a day, its
 * count stale from the moment a fifth intake item landed. A suite you have to remember to run is a
 * suite that measures whoever is remembering.
 *
 * ── NOT RUN IS NOT A PASS, AND IT IS NOT A FAILURE ──────────────────────────────────────────────
 * Gates need different things: a dev server, a database, a browser. A gate whose prerequisite is
 * missing has told you NOTHING, and the one thing that must never happen is a real failure hiding
 * behind an environment excuse. So there are three states, not two, and UNRUN is printed as loudly
 * as RED — with the reason and what would fix it. The headline always names the unrun count, even
 * when it is zero.
 *
 * Honest-null, applied to a test suite: "not run" is a different fact from "passed".
 *
 * UNRUN HAS TWO CAUSES and one meaning. The gate started and declined (exit 4: leftover fixtures, a
 * pay run already open), or the runner never started it because a requirement it declared was not
 * met. They are counted together because nothing was tested either way, and told apart on the line,
 * because clearing a fixture and starting a server are different people's afternoons.
 *
 * ── THE EXIT CODE IS THE CONTRACT ───────────────────────────────────────────────────────────────
 * Gates report in at least three different formats (`check`/`chk`/bare asserts). Parsing output
 * would make the runner a second, wrong source of truth about whether a gate passed. It runs the
 * file and reads the exit code; the "N failures of M" line is parsed only to enrich the summary,
 * and its absence is not an error.
 *
 * Usage:
 *   node scripts/gates.mjs                 every gate
 *   node scripts/gates.mjs --tier money    only the money paths (see TIERS)
 *   node scripts/gates.mjs --resume        skip gates already recorded in the results file
 *   node scripts/gates.mjs --list          print the plan and prerequisites, run nothing
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { DEV_PORT } from './_dev-port.mjs';

/** Mirrors _gate-preflight::EXIT_UNRUN — the runner cannot import it, it runs before any gate. */
const EXIT_UNRUN = 4;
import { spawn } from 'node:child_process';
// THE RUNNER HAD NO DATABASE_URL. Nothing here loaded .env — each gate loaded it for itself — so
// the tuning below had nothing to tune and would have handed every child a URL consisting of
// "?connection_limit=10&pool_timeout=20" and nothing else. dotenv does not override an env var
// that is already set, so that broken value would have WON in every child and taken out the whole
// suite. Load it here, where the URL is now actually needed.
import 'dotenv/config';
import { firstFailureLine } from './_gate-summary.mjs';
// The one key matcher — imported directly: this runner cannot load _gate-preflight (see gate-origin-gate).
const { keyRegex } = await import('../lib/anchored-match.ts');

/**
 * ── THE POOL A GATE GETS, STATED RATHER THAN INHERITED ──────────────────────────────────────────
 * Every gate is its own process with its own Prisma pool, and the URL carried NO connection_limit
 * and NO pool_timeout — so Prisma used its default of num_cpus * 2 + 1, which is 33 on this
 * machine. That number describes a laptop, not a Neon pooler, and it is the parameter actually
 * governing the failures: marketing-board-gate dies at the same check every in-tier run, and that
 * check is the one immediately before buildBoard, whose two Promise.all bursts ask for six
 * connections at once from a client that has so far opened one.
 *
 *   connection_limit=10 — comfortably above the largest burst any gate makes (six), and far below
 *                         a number that invites the pooler to hand out sessions nobody needs. A
 *                         gate is sequential; it has no use for 33.
 *   pool_timeout=20     — doubled from the 10s default, because a Neon compute waking from
 *                         autosuspend takes seconds and the old value gave up during the wake. It
 *                         is a ceiling on waiting, not on working.
 *
 * DB_RETRY_TRANSIENT=1 turns on lib/db's existing retry, which its own header says exists "for the
 * bulk scripts" and is off by default so nothing about a Vercel request changes. A gate run IS a
 * long local run. NOTE it reaches only the 52 gates that import lib/db — the 43 constructing a
 * bare PrismaClient bypass it, and marketing-board-gate is one of those, so the URL settings above
 * are the only thing that touches it. Routing those 43 is its own slice.
 */
function gateEnv() {
  const url = process.env.DATABASE_URL;
  // NO URL, NO TUNING. Setting a partial one would be worse than leaving it alone: the child would
  // inherit a broken value it cannot override.
  if (!url) return { ...process.env, DB_RETRY_TRANSIENT: '1' };
  const tuned = /connection_limit=/.test(url)
    ? url
    : `${url}${url.includes('?') ? '&' : '?'}connection_limit=10&pool_timeout=20`;
  return { ...process.env, DATABASE_URL: tuned, DB_RETRY_TRANSIENT: '1' };
}
import path from 'node:path';

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, '.gate-results.json');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/**
 * ── TIERS ARE CURATED, AND EVERY GATE MUST BE IN ONE ────────────────────────────────────────────
 * Not inferred from filenames: "payment-invariant" and "revenue-period" are money, "sms-suffix" is
 * not, and no pattern separates them. An UNCLASSIFIED gate fails the runner rather than being
 * quietly left out — a new gate that nobody tiered would otherwise vanish from the fast run and
 * look like coverage.
 *
 *   money — anything that decides what a customer is charged, what we are paid, or what is owed.
 *           This is the subset to run on every change.
 *   core  — correctness of the workshop record: the spine, capture, findings, the documents.
 *   slow  — browser-driven surface checks. Real, and the ones that cost minutes.
 */
const TIERS = {
  money: [
    'flat-commission-gate',
    'account-terms-gate', 'application-fee-gate', 'card-fulfilment-gate', 'commission-fixed-clock-gate',
    'commission-refusal-gate', 'counter-payment-gate', 'credit-note-gate', 'invoice-pay-link-gate',
    'rep-visit-gate', 'rep-answers-gate', 'rep-pay-run-gate', 'rep-auth-gate', 'rep-invoice-gate',
    'never-subscribes-gate', 'payment-intent-gate', 'payment-invariant-gate', 'pay-refusal-gate',
    'pay-surfaces-gate', 'payments-section-gate', 'refund-button-gate', 'refund-reconcile-gate',
    'refund-surfaces-gate', 'refund-tab-gate', 'refunded-state-gate', 'revenue-period-gate',
    'rolling-12-gate', 'wip-derivation-gate', 'poisoned-transaction-gate', 'trading-name-gate',
    'sms-allowance-gate',
  ],
  core: [
    'date-constant-gate', 'purge-completeness-gate', 'client-bundle-gate', 'gate-origin-gate', 'anchored-match-gate', 'contact-preferences-gate', 'carrier-stop-gate',
    'schema-drift-gate',
    'rep-host-gate',
    'engine-room-palette-gate',
    'support-route-gate',
    'admin-shell-gate', 'client-freshness-gate', 'customer-answers-gate', 'data-start-clip-gate',
    'demo-fuel-gate', 'document-credit-gate', 'marketing-board-gate', 'demo-lifecycle-gate', 'demo-profile-gate',
    'demo-subject-gate', 'due-items-gate', 'due-timing-gate', 'gate-hygiene-gate',
    'seeds-from-props-gate',
    'intake-prompts-gate', 'intake-report-gate', 'quote-worklist-gate', 'prospect-gate', 'no-show-gate', 'notify-scope-gate',
    'nullable-annotation-gate', 'observation-key-gate', 'odometer-gate', 'photo-partition-gate',
    'phone-gate-blast-radius', 'prisma-any-gate', 'pwa-intake-gate', 'send-outcome-gate',
    'sms-sends-gate', 'sms-suffix-gate', 'spine-gate', 'status-union-gate', 'tenant-scope-gate',
    'tyres-gate', 'marketing-lists-gate', 'intake-escalation-gate',
    'mot-sweep-stamp-gate', 'enum-drift-gate', 'tax-display-gate', 'trial-extend-gate', 'printed-countdown-gate', 'invoice-blocks-gate', 'quote-lead-gate', 'quote-drafts-gate', 'costbase-clip-gate', 'retry-transient-gate', 'wage-per-month-gate', 'costs-gate',
  ],
  /**
   * ── MANUAL: RUN ON PURPOSE, NOT ON EVERY PASS ────────────────────────────────────────────────
   * Still DECLARED, deliberately. Deleting a gate from every tier makes it vanish — it stops being
   * reported and nobody notices it is gone, which is worse than a red. Listed here it appears in
   * `--list` with a tier, and a bare `node scripts/gates.mjs` (no --tier) still runs it.
   *
   * demo-generation-gate generates a whole tenant — 810 cards — and exceeded its 2,700s limit three
   * times on 31 Aug 2026 while the database was slow, once taking 2h54m at 0% CPU. Each failure
   * stops before its own teardown and ORPHANS the tenant it made, which then makes
   * demo-lifecycle-gate refuse. So a bad afternoon cost three orphans and put 24 minutes on every
   * core run for a result nobody could act on.
   *
   * Run it deliberately, when the database is quick and somebody is watching:
   *     node scripts/gates.mjs --tier manual
   *     node scripts/demo-generation-gate.mjs
   * and check for a leftover Gateholm tenant afterwards if it does not finish.
   */
  manual: ['demo-generation-gate'],
  slow: [
    'battery-gate', 'bay-write-gate', 'closure-kind-gate', 'invoice-snapshot-gate', 'condition-visibility-gate', 'consent-reach-gate', 'intake-offer-gate',
    'marketing-send-gate', 'messages-tab-gate', 'mot-capture-gate', 'mot-refresh-gate',
    'observations-gate', 'oil-level-gate', 'quote-invoice-sms-gate', 'service-schedule-gate',
    'tyre-form-memory-gate', 'phone-capture-timing', 'marketing-call-view-gate',
    'duplicate-card-gate', 'quote-line-order-gate', 'schedule-reread-gate', 'mot-mint-gate',
    'mot-booking-stamp-gate', 'completion-carry-gate', 'diag-scan-gate',
    'dashboard-period-copy-gate',
    'reporting-anchor-gate',
    'trial-control-gate',
    'free-tenant-gate',
    'free-not-checkout-gate',
    'free-reconcile-gate',
    'overheads-retired-gate',
    'cost-confirm-gate',
    'billed-party-gate',
    'lookup-reset-gate',
  ],
};

const tierOf = (g) => Object.keys(TIERS).find((t) => TIERS[t].includes(g)) ?? null;

/** Everything in scripts/ that is a gate. `_gate-*` are helpers, not gates. */
function discover() {
  return readdirSync(path.join(ROOT, 'scripts'))
    // The runner is not one of its own gates, and 'gates.mjs' matches the pattern that finds them.
    .filter((f) => f.endsWith('.mjs') && /gate|timing/.test(f) && !f.startsWith('_') && f !== 'gates.mjs')
    .map((f) => f.replace(/\.mjs$/, ''))
    .sort();
}

// THE ONE ORIGIN. Mirrors _gate-preflight::gateOrigin — the runner cannot import it, because this
// file must run before any gate loads, but gate-origin-gate asserts the two agree.
const ORIGIN = process.env.GATE_BASE ?? `http://localhost:${DEV_PORT}`;

/**
 * A DECLARATION NAMES AN ORIGIN, NOT A PORT NUMBER IN ISOLATION. `server` is the configured one;
 * `server:NNNN` is the SAME HOST on a different port, so a run pointed elsewhere by GATE_BASE
 * carries the whole declaration with it rather than half of it.
 */
const originFor = (spec) => {
  if (spec === 'server') return ORIGIN;
  const u = new URL(ORIGIN);
  u.port = String(Number(spec.split(':')[1]));
  return u.origin;
};

/**
 * WHAT A GATE NEEDS, read from the gate itself.
 *
 * Inferred rather than listed in a table here, because a table is a second source of truth that
 * drifts the moment somebody changes a port. A gate may override with an explicit declaration:
 *
 *     // @gate-requires: server:3111, db
 */
function requirements(file) {
  const src = readFileSync(file, 'utf8');
  const declared = src.match(/@gate-requires:\s*([^\n]+)/);
  if (declared) {
    const parts = declared[1].split(',').map((s) => s.trim()).filter(Boolean);
    return {
      // `server` alone means THE configured origin. A declaration naming a port would be a second
      // place the number lives, which is the whole point of _dev-port. `server:NNNN` is still
      // parsed, for a gate that genuinely needs a different one.
      //
      // The spec string is KEPT ALONGSIDE the origin it resolves to, because an unmet requirement
      // has to be reportable in the words the gate used. "needs a server" names nothing; "declares
      // server:9999 → http://localhost:9999, nothing answered" names the line to go and read.
      servers: parts.filter((p) => p === 'server' || p.startsWith('server:'))
        .map((spec) => ({ spec, origin: originFor(spec) })),
      db: parts.includes('db'),
      declared: true,
    };
  }
  // NEEDS THE SERVER, inferred from the HELPER it calls rather than a port literal it contains.
  // The literals are gone — gateOrigin() and erOrigin() are the single source (see
  // _gate-preflight and gate-origin-gate) — so scanning for `localhost:3000` now finds nothing and
  // would quietly report every browser gate as needing no server at all.
  const needsServer = /\bgateOrigin\(|\berOrigin\(|\bserverReady\(/.test(src);
  const servers = needsServer ? [{ spec: 'server', origin: ORIGIN }] : [];
  return { servers, db: /PrismaClient|lib\/db\.ts/.test(src), declared: false };
}

/**
 * ── IS THIS GREASEDESK, OR JUST SOMETHING THAT ANSWERS? ─────────────────────────────────────────
 * This asked `r.status > 0` — true of ANY http response, including a 404 from an unrelated app. On
 * 2026-09-08 another project on this machine held port 3000, and the runner cheerfully reported the
 * server up while two gates drove that application for a day and a half. Their reds were not reds.
 *
 * So: identity, and a GreaseDesk-specific one. middleware.ts serves /superadmin ONLY on
 * er.greasedesk.com and 404s it everywhere else — a behaviour no generic Next app has. One request
 * with that Host answers both "is this GreaseDesk" and "is the host routing the two er. gates
 * depend on actually working". Measured against both apps: GreaseDesk 200, the other 404.
 *
 * Returns a REASON rather than a boolean, because "nothing answered" and "something answered and it
 * was not us" need different sentences from the caller.
 */
const identify = (origin) => new Promise((resolve) => {
  // NODE:HTTP, NOT FETCH. `Host` is a forbidden header name in fetch — undici strips it silently,
  // so the request goes out as localhost, middleware 404s /superadmin, and the check fails against
  // GreaseDesk itself. Found by pointing it at a server known to be GreaseDesk and watching it
  // refuse. The raw client sets the header the resolver rule would have produced.
  const u = new URL(origin);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: '/superadmin/login', method: 'GET',
    headers: { Host: 'er.greasedesk.com' }, timeout: 6000,
  }, (res) => {
    res.resume();
    resolve(res.statusCode === 200
      ? { ok: true }
      : { ok: false, why: `answered ${res.statusCode} on /superadmin/login as er.greasedesk.com — GreaseDesk answers 200` });
  });
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: `nothing answered on ${origin} within 6s` }); });
  req.on('error', () => resolve({ ok: false, why: `nothing answered on ${origin}` }));
  req.end();
});

/**
 * ── IS THE SERVER ON THIS PORT RUNNING A CLIENT IT HAS OUTLIVED? ────────────────────────────────
 * `prisma generate` writes a new client into node_modules; a dev server started before that keeps
 * the OLD one in memory. lib/db then REFUSES every query, and because NextAuth reports any throw
 * inside authorize() as InvalidCredentials, it surfaces as a wrong password — plus 500s on pages
 * that read anything. See lib/client-freshness, whose own header records this costing seven or
 * eight interruptions and twice sending the investigation into the wrong subsystem.
 *
 * ASKED ONCE, HERE, BECAUSE THE SYMPTOM IS NOT AN EXCEPTION. Gates already call
 * explainIfClientStale — but only from their `catch`, and a stale client makes assertions FAIL
 * rather than throw, so the catch never runs and the explainer never fires. On 2026-09-06 that
 * turned one cause into eleven unrelated-looking reds across the core tier, three times in a day.
 *
 * ── AND IT IS NO LONGER ASKED ON A CUSTOMER PATH ───────────────────────────────────────────────
 * This fetched /c/aaaaaaaaaaaaaaaa, a customer magic-link route rate-limited at 60 per IP per hour,
 * and read the guard's banner out of the HTML. One per runner invocation, plus one per FAILING gate
 * from explainIfClientStale — measured at 23 per full sweep against a budget of 60, so under three
 * sweeps an hour before the suite locked itself out and gates began failing on the limiter rather
 * than on anything they test.
 *
 * /api/dev/client-freshness exists for this, is 404 in production, and is not rate limited.
 */
const staleClient = async (origin) => {
  try {
    const r = await fetch(`${origin}/api/dev/client-freshness`, { signal: AbortSignal.timeout(6000) });
    return keyRegex('stale', 'true').test(await r.text());
  } catch { return false; } // unreachable is a different problem, and the identity probe reports it
};

/**
 * ── A GATE THAT NEVER RETURNS IS WORSE THAN A GATE THAT FAILS ───────────────────────────────────
 * The first version of this runner had no per-gate timeout, and the first full run proved why:
 * demo-generation-gate sat for thirteen minutes with the suite behind it, indistinguishable from
 * slow. A hang is not a third kind of pass — it is a gate that never reported, so it is counted
 * RED with the reason, and the suite carries on.
 *
 * 300s because the slowest honest gate measured ~90s. Raise it for a specific gate with
 * `// @gate-timeout: 600`, which is a decision someone makes in the gate rather than a ceiling
 * quietly lifted for everybody.
 */
const DEFAULT_TIMEOUT_S = 300;

function run(gate) {
  return new Promise((resolve) => {
    const started = Date.now();
    const src = readFileSync(path.join(ROOT, 'scripts', `${gate}.mjs`), 'utf8');
    const limit = Number((src.match(/@gate-timeout:\s*(\d+)/) ?? [])[1] ?? DEFAULT_TIMEOUT_S) * 1000;
    const child = spawn('node', [path.join('scripts', `${gate}.mjs`)], { cwd: ROOT, env: gateEnv() });
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit);
    let timedOut = false;
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(killer);
      const m = out.match(/(\d+) failures of (\d+)/g);
      const last = m ? m[m.length - 1].match(/(\d+) failures of (\d+)/) : null;
      resolve({
        gate, code: timedOut ? 124 : code, timedOut,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        failures: last ? Number(last[1]) : null,
        assertions: last ? Number(last[2]) : null,
        // The first failing line, so the summary says WHAT rather than only THAT.
        firstFailure: timedOut
          ? `NEVER RETURNED — killed after ${limit / 1000}s. A hang is not a pass.`
          : firstFailureLine(out),
        log: out.slice(-4000),
      });
    });
  });
}

const gates = discover();

// EVERY GATE IS TIERED, or the run refuses. A gate nobody classified would silently vanish from
// the fast run and be mistaken for coverage.
const untiered = gates.filter((g) => !tierOf(g));
if (untiered.length) {
  console.error(`\nREFUSING TO RUN — ${untiered.length} gate(s) are in no tier:\n  ${untiered.join('\n  ')}\n`);
  console.error('Add each to TIERS in scripts/gates.mjs. An unclassified gate is not a fast gate;');
  console.error('it is a gate whose absence from the fast run nobody decided.\n');
  process.exit(2);
}

const tier = val('--tier');
if (tier && !TIERS[tier]) { console.error(`Unknown tier "${tier}". One of: ${Object.keys(TIERS).join(', ')}`); process.exit(2); }
let plan = tier ? gates.filter((g) => tierOf(g) === tier) : gates;

const prior = has('--resume') && existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
if (has('--resume')) plan = plan.filter((g) => !prior[g]);

// PREREQUISITES, PROBED ONCE. Every distinct port is checked before anything runs, so a missing
// dev server is reported as one fact rather than rediscovered by twenty gates in a row.
const needed = new Set();
const reqs = {};
for (const g of plan) { reqs[g] = requirements(path.join(ROOT, 'scripts', `${g}.mjs`)); reqs[g].servers.forEach((sv) => needed.add(sv.origin)); }

// ── WHICH TIERS RAN WITHOUT ANYTHING CONFIRMING WHAT THEY WERE TESTING ─────────────────────────
// A tier where no gate asks for a server is never identity-checked, because there is nothing to
// check. That is fine and it is also worth SAYING: the manual tier reads the repo and the database
// and is entirely capable of going green while the app under test is a different app, or absent.
// Left unsaid, "0 UNRUN" invites the reader to hear a guarantee the run never made.
const tierIn = (g) => tierOf(g) ?? 'untiered';
const tiersInPlan = [...new Set(plan.map(tierIn))];
const uncheckedTiers = tiersInPlan.filter((t) => !plan.some((g) => tierIn(g) === t && reqs[g].servers.length));
if (has('--list')) {
  for (const g of plan) {
    const r = reqs[g];
    console.log(`${g.padEnd(32)} ${(tierOf(g) ?? '?').padEnd(6)} ${r.servers.length ? r.servers.map((sv) => sv.origin).join(',') : '—'} ${r.db ? 'db' : ''} ${r.declared ? '(declared)' : ''}`);
  }
  console.log(`\n${plan.length} gates. Origins needed: ${needed.size ? [...needed].join(', ') : 'none'}`);
  process.exit(0);
}

// ── ONE PROBE PER ORIGIN, AND A REQUIREMENT IS SATISFIED ONLY BY ITS OWN ───────────────────────
// This block used to end `for (const p of needed) up[p] = true` — every requirement marked
// satisfied as a SIDE EFFECT of the configured origin answering. A gate declaring server:9999, a
// port nothing listens on, ran anyway, and the suite reported 0 skipped. The header humans read as
// a guard had been decoration since the identity change that introduced the line.
//
// Now: each distinct origin is probed once, by the same identity probe, and a gate's requirement
// is met only if ITS origin's own result says so.
const up = {};
for (const origin of needed) up[origin] = await identify(origin);

// IDENTITY BEFORE ANYTHING. A suite that cannot confirm what it is testing has no counts to
// report, so this refuses the whole run rather than proceeding with a warning. This applies to the
// CONFIGURED origin only: it is what nearly every gate uses, so its absence is a mass misreport
// rather than one gate's problem. An origin some single gate declared for itself fails that gate.
if (needed.has(ORIGIN)) {
  const id = up[ORIGIN];
  if (!id.ok) {
    console.error(`\n  ${ORIGIN} IS NOT GREASEDESK.\n`);
    console.error(`  ${id.why}.`);
    console.error('  On 2026-09-08 another project on this machine held port 3000 and the runner');
    console.error('  reported the server up for a day and a half while two gates drove it.');
    console.error('  NOTHING HAS BEEN RUN, and there are no counts: a suite that cannot confirm');
    console.error('  what it is testing has nothing to say about it.\n');
    console.error('  Start GreaseDesk there, or set GATE_BASE to where it is.\n');
    process.exit(3);
  }
}

// ── REFUSE THE WHOLE RUN RATHER THAN MISREPORT IT ───────────────────────────────────────────────
// A stale client does not fail one gate honestly, it fails every gate dishonestly. Aborting here
// costs one restart; not aborting costs an afternoon reading the wrong files.
if (needed.has(ORIGIN) && await staleClient(ORIGIN)) {
  console.error(`\n  THE DEV SERVER AT ${ORIGIN} IS RUNNING AN OLD PRISMA CLIENT.\n`);
  console.error('  `prisma generate` has run since it started, so lib/db refuses every query — which');
  console.error('  looks like InvalidCredentials on login and 500s everywhere else, not like this.');
  console.error('  NOTHING HAS BEEN RUN: every gate would have failed for a reason that is not theirs.\n');
  console.error('  Restart the dev server and run again. `npm run dev` now does this for you.\n');
  process.exit(3);
}



// ── THE SUITE'S OWN RATE-LIMIT CARRY-OVER, CLEARED ONCE, OUT LOUD ──────────────────────────────
// The gates drive real customer surfaces, so they spend real limiter budget: measured on
// 2026-09-09 from a cleared baseline, a full sweep costs 23 of magic:ip's 60 per hour. Past that,
// gates fail on the limiter instead of on what they test — five did — and the counts start
// depending on how recently somebody last ran, which is a number nobody states.
//
// ONCE, HERE, BEFORE THE FIRST GATE. Never between gates: a gate that asserts "the Nth request is
// refused" must still be able to, inside its own run. None does today; that is why it is checked.
//
// NO LIMIT IS WEAKENED. magic:ip is still 60, repauth:ip still 30. What goes is the carry-over
// between runs, which exists only because one machine is every caller.
const reap = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', '_reap-loopback-limits.mjs'), ORIGIN],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; });
  p.on('close', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, reason: 'no_answer' }); } });
  p.on('error', () => resolve({ ok: false, reason: 'no_answer' }));
});
// PRINTED EVEN AT ZERO, and printed again in the summary. Same rule as UNRUN and the identity line:
// a line that only appears when something happened is a line nobody looks for on the day it matters.
const reapLine = reap.ok
  ? `LIMITER: cleared ${reap.cleared} loopback row(s)${reap.keys.length ? ` — ${reap.keys.join(', ')}` : ''}; ${reap.untouched} other key(s) untouched`
  : `LIMITER: NOT cleared (${reap.reason}${reap.host ? ` — ${reap.host}` : ''}) — the suite's own carry-over is still in place`;
console.log(`\n${reapLine}`);

const results = { ...prior };
for (const g of plan) {
  const r = reqs[g];
  // AN UNMET REQUIREMENT IS UNRUN, NOT A FOURTH WORD FOR IT. The gate never started, so it has
  // told you nothing — the same fact as a gate that started and declined. The reason names the
  // declaration and what the probe found, so the reader is not left to guess which of the two.
  const unmetReqs = r.servers.filter((sv) => !up[sv.origin].ok);
  if (unmetReqs.length) {
    const why = unmetReqs.map((sv) => `declares ${sv.spec} — ${up[sv.origin].why}`).join('; ');
    results[g] = { gate: g, unrun: true, unmet: true, reason: why, tier: tierOf(g) };
    console.log(`UNRUN ${g.padEnd(32)} ${why}`);
  } else {
    const res = await run(g);
    // ── THE TAIL IS KEPT FOR RED GATES ONLY ──────────────────────────────────────────────────
    // `firstFailure` is the FIRST ✗ line, capped at 110 characters, and for a gate that dies that
    // line is its catch-all: "run completed — page.waitForSelector: Timeout 30000ms exceeded" says
    // nothing about which selector, on which page, after which check. Four flakes in one afternoon
    // each had to be reproduced by hand to be understood, and reproducing them alone is exactly
    // what makes them pass.
    //
    // Green gates keep today's shape: 4KB × 78 to explain nothing is not a trade worth making.
    // Red and timed-out gates keep the tail — typically 3-12 of them, a few tens of KB.
    //
    // WHAT THE TAIL IS: the last 4KB of the child's stdout and stderr, MERGED (run() appends both
    // to one buffer). It is gate output, so it may contain tenant data — registrations, customer
    // names, a magic-link token in a URL. This file is gitignored and never leaves the machine,
    // which is the only reason keeping it is acceptable; it is a local debugging artefact, not
    // something to copy into an issue without reading it first.
    // ── FOUR STATES, NOT THREE ────────────────────────────────────────────────────────────────
    // EXIT_UNRUN (4) means the gate DECLINED TO START — leftover fixtures, a pay run already open.
    // It is not green and it is not red: a red says the code under test is broken, and a decline
    // says nothing was tested. Reporting the second as the first is how a reader learns to skim
    // reds, which is how "body padding-bottom 0px" sat for two days over a dead customer pay page.
    const unrun = res.code === EXIT_UNRUN;
    const reason = unrun ? (res.log.match(/UNRUN — ([^\n]+)/) ?? [])[1] ?? 'declined to start' : null;
    results[g] = { ...res, unrun, reason, tier: tierOf(g), log: res.code === 0 ? undefined : res.log };
    const state = res.code === 0 ? 'ok   ' : unrun ? 'UNRUN' : 'RED  ';
    console.log(`${state} ${g.padEnd(32)} ${String(res.seconds).padStart(6)}s  ${!unrun && res.failures != null ? `${res.failures} of ${res.assertions}` : ''}`);
    if (unrun) console.log(`        ${reason}`);
    else if (res.code !== 0 && res.firstFailure) console.log(`        ${res.firstFailure}`);
  }
  writeFileSync(RESULTS, JSON.stringify(results, null, 1));
}

// ── THE SUMMARY, WITH THREE STATES ─────────────────────────────────────────────────────────────
const all = Object.values(results);
const unrunGates = all.filter((r) => r.unrun);
const red = all.filter((r) => !r.unrun && r.code !== 0);
// A STRICT SUBSET, NOT A FIFTH STATE. Both kinds of unrun mean nothing was tested; this number
// says how many of them were the ENVIRONMENT rather than the gate's own precondition, because
// those are fixed by different people doing different things.
const unmet = unrunGates.filter((r) => r.unmet);
const green = all.filter((r) => !r.unrun && r.code === 0);
const secs = green.concat(red).reduce((a, r) => a + (r.seconds ?? 0), 0);

console.log(`\n${'='.repeat(76)}`);
// FOUR NUMBERS, ALWAYS. Unrun is never folded into green or red — a tier that reads
// "27 green · 1 red" when a clause declined to start is a tier reporting coverage it does not have.
console.log(`${green.length} green · ${red.length} RED · ${unrunGates.length} UNRUN · ${unmet.length} of those an unmet requirement · ${Math.round(secs)}s`);
if (red.length) {
  console.log('\nRED:');
  for (const r of red) console.log(`  ${r.gate.padEnd(32)} ${r.failures != null ? `${r.failures} of ${r.assertions}` : `exit ${r.code}`}  ${r.firstFailure ?? ''}`);
}
// PRINTED EVEN AT ZERO, so the reader keeps looking for it. A line that appears only when there is
// bad news is a line nobody reads on a good day, and then nobody reads on a bad one either.
console.log(`\nUNRUN: ${unrunGates.length}`);
for (const r of unrunGates) console.log(`  ${r.gate.padEnd(32)} ${r.reason}`);
if (unrunGates.length) console.log('\n  An unrun gate has told you nothing. Clear what it needs and run again.');

// PRINTED EVEN WHEN THERE IS NOTHING TO SAY, by the same rule as UNRUN above: a line that appears
// only when it is bad news is a line the reader stops looking for.
// THE COST, STATED. Absorbed silently, this reads as free; it is not, and the number is what tells
// a reader whether the suite is close to spending a budget it does not own.
console.log(`\n${reapLine}`);
console.log('  Budget, re-measured 2026-09-09 after the diagnostics moved off /c/:');
console.log('    core 0  ·  money 17 magic:ip + 7 repauth:ip  ·  slow 3 magic:ip  ·  the runner itself 0');
console.log('    A full sweep spends 20 of magic:ip\'s 60/hour and 7 of repauth:ip\'s 30.');
console.log('    Previously 23, plus one more for EVERY gate that failed — reds caused exhaustion and');
console.log('    exhaustion caused reds. That amplifier is gone; the remaining spend is gates driving');
console.log('    real customer links, which is what they are for. No limit is weakened.');
console.log(uncheckedTiers.length
  ? `\nNO IDENTITY CHECK: ${uncheckedTiers.join(', ')}\n  No gate in ${uncheckedTiers.length > 1 ? 'those tiers' : 'that tier'} asks for a server, so nothing confirmed what was under test.\n  Green there means the repo and the database are right — not that GreaseDesk was running.`
  : '\nIDENTITY: every tier in this run had at least one gate probe the server.');
console.log(`${'='.repeat(76)}\n`);

// 1 = something is broken. 5 = nothing is broken and something was not tested. Distinct, because a
// caller that treats them the same is a caller that cannot tell coverage from correctness.
process.exit(red.length ? 1 : unrunGates.length ? 5 : 0);
