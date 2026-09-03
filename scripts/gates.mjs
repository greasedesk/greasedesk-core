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
 * ── A SKIP IS NOT A PASS, AND IT IS NOT A FAILURE ───────────────────────────────────────────────
 * Gates need different things: a dev server on 3000, 3111 or 3112, a database, a browser. A gate
 * whose prerequisite is missing has told you NOTHING, and the one thing that must never happen is a
 * real failure hiding behind an environment excuse. So there are three states, not two, and SKIPPED
 * is printed as loudly as RED — with the reason and the command that would fix it. The headline
 * always names the skip count, even when it is zero.
 *
 * Honest-null, applied to a test suite: "not run" is a different fact from "passed".
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
import { spawn } from 'node:child_process';
// THE RUNNER HAD NO DATABASE_URL. Nothing here loaded .env — each gate loaded it for itself — so
// the tuning below had nothing to tune and would have handed every child a URL consisting of
// "?connection_limit=10&pool_timeout=20" and nothing else. dotenv does not override an env var
// that is already set, so that broken value would have WON in every child and taken out the whole
// suite. Load it here, where the URL is now actually needed.
import 'dotenv/config';
import { firstFailureLine } from './_gate-summary.mjs';

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
    'account-terms-gate', 'application-fee-gate', 'card-fulfilment-gate', 'commission-fixed-clock-gate',
    'commission-refusal-gate', 'counter-payment-gate', 'credit-note-gate', 'invoice-pay-link-gate',
    'never-subscribes-gate', 'payment-intent-gate', 'payment-invariant-gate', 'pay-refusal-gate',
    'pay-surfaces-gate', 'payments-section-gate', 'refund-button-gate', 'refund-reconcile-gate',
    'refund-surfaces-gate', 'refund-tab-gate', 'refunded-state-gate', 'revenue-period-gate',
    'rolling-12-gate', 'wip-derivation-gate', 'poisoned-transaction-gate', 'trading-name-gate',
    'sms-allowance-gate',
  ],
  core: [
    'admin-shell-gate', 'client-freshness-gate', 'customer-answers-gate', 'data-start-clip-gate',
    'demo-fuel-gate', 'document-credit-gate', 'marketing-board-gate', 'demo-lifecycle-gate', 'demo-profile-gate',
    'demo-subject-gate', 'due-items-gate', 'due-timing-gate', 'gate-hygiene-gate',
    'seeds-from-props-gate',
    'intake-prompts-gate', 'intake-report-gate', 'no-show-gate', 'notify-scope-gate',
    'nullable-annotation-gate', 'observation-key-gate', 'odometer-gate', 'photo-partition-gate',
    'phone-gate-blast-radius', 'prisma-any-gate', 'pwa-intake-gate', 'send-outcome-gate',
    'sms-sends-gate', 'sms-suffix-gate', 'spine-gate', 'status-union-gate', 'tenant-scope-gate',
    'tyres-gate', 'marketing-lists-gate', 'intake-escalation-gate',
    'mot-sweep-stamp-gate', 'enum-drift-gate', 'printed-countdown-gate', 'invoice-blocks-gate', 'quote-lead-gate', 'quote-drafts-gate', 'costbase-clip-gate', 'retry-transient-gate', 'wage-per-month-gate', 'costs-gate',
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
    'billed-party-gate',
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
      ports: parts.filter((p) => p.startsWith('server:')).map((p) => Number(p.split(':')[1])),
      db: parts.includes('db'),
      declared: true,
    };
  }
  const ports = [...new Set([...src.matchAll(/localhost:(\d{4})/g)].map((m) => Number(m[1])))];
  return { ports, db: /PrismaClient|lib\/db\.ts/.test(src), declared: false };
}

const probe = async (port) => {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(4000) });
    return r.status > 0;
  } catch { return false; }
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
for (const g of plan) { reqs[g] = requirements(path.join(ROOT, 'scripts', `${g}.mjs`)); reqs[g].ports.forEach((p) => needed.add(p)); }
const up = {};
for (const p of needed) up[p] = await probe(p);

if (has('--list')) {
  for (const g of plan) {
    const r = reqs[g];
    console.log(`${g.padEnd(32)} ${(tierOf(g) ?? '?').padEnd(6)} ${r.ports.length ? `server:${r.ports.join(',')}` : '—'} ${r.db ? 'db' : ''} ${r.declared ? '(declared)' : ''}`);
  }
  console.log(`\n${plan.length} gates. Ports needed: ${[...needed].map((p) => `${p}=${up[p] ? 'up' : 'DOWN'}`).join(' ') || 'none'}`);
  process.exit(0);
}

const results = { ...prior };
for (const g of plan) {
  const r = reqs[g];
  const missing = r.ports.filter((p) => !up[p]);
  if (missing.length) {
    results[g] = { gate: g, skipped: true, reason: `needs a server on ${missing.join(', ')}`, tier: tierOf(g) };
    console.log(`SKIP  ${g.padEnd(32)} needs a server on ${missing.join(', ')}`);
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
    results[g] = { ...res, tier: tierOf(g), log: res.code === 0 ? undefined : res.log };
    const state = res.code === 0 ? 'ok  ' : 'RED ';
    console.log(`${state}  ${g.padEnd(32)} ${String(res.seconds).padStart(6)}s  ${res.failures != null ? `${res.failures} of ${res.assertions}` : ''}`);
    if (res.code !== 0 && res.firstFailure) console.log(`        ${res.firstFailure}`);
  }
  writeFileSync(RESULTS, JSON.stringify(results, null, 1));
}

// ── THE SUMMARY, WITH THREE STATES ─────────────────────────────────────────────────────────────
const all = Object.values(results);
const red = all.filter((r) => !r.skipped && r.code !== 0);
const skipped = all.filter((r) => r.skipped);
const green = all.filter((r) => !r.skipped && r.code === 0);
const secs = green.concat(red).reduce((a, r) => a + (r.seconds ?? 0), 0);

console.log(`\n${'='.repeat(76)}`);
console.log(`${green.length} green · ${red.length} RED · ${skipped.length} SKIPPED (not run — see below) · ${Math.round(secs)}s`);
if (red.length) {
  console.log('\nRED:');
  for (const r of red) console.log(`  ${r.gate.padEnd(32)} ${r.failures != null ? `${r.failures} of ${r.assertions}` : `exit ${r.code}`}  ${r.firstFailure ?? ''}`);
}
// PRINTED EVEN WHEN THERE ARE NONE. "0 skipped" is the sentence that makes a green run mean
// something; a summary that mentions skips only when they exist trains the reader not to look.
console.log(`\nSKIPPED: ${skipped.length}`);
for (const r of skipped) console.log(`  ${r.gate.padEnd(32)} ${r.reason}`);
if (skipped.length) console.log('\n  A skipped gate has told you nothing. Start what it needs and run again.');
console.log(`${'='.repeat(76)}\n`);

process.exit(red.length ? 1 : 0);
