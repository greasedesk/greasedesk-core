/**
 * File: scripts/migrate-apply.mjs
 * THE ONLY WAY TO APPLY A MIGRATION. Asks production what it is running first.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────────────────────────
 * Dev and production share one database, so a migration is live the moment it is applied while the
 * code that honours it is live only when it deploys. A migration that CONSTRAINS an existing write
 * therefore breaks production between apply and push, and no gate can catch it — every gate runs
 * against this working copy, where the satisfying code is already there.
 *
 * It happened on 2026-09-11: a trigger applied at 17:43 UTC while production ran 68fa1a3, whose
 * owner-edit API wrote the constrained columns directly. Four hours of 500s on every "No SMS" save.
 *
 * POLICY (owner, 2026-09-12): two pushes per constraining change — push the code, wait until
 * production is RUNNING it, then apply and push the migration. This enforces the waiting.
 *
 *   node scripts/migrate-apply.mjs                      # classify, check, apply
 *   node scripts/migrate-apply.mjs --dry-run            # say what it would do, apply nothing
 *   node scripts/migrate-apply.mjs --even-if-not-live="<reason>"
 *
 * ── WHY THE RULES ARE NOT IN HERE ───────────────────────────────────────────────────────────────
 * Every refusal lives in lib/migration-deploy-rules.ts as a pure function of facts this script
 * gathers. That is what lets migration-class-gate prove all of them — unreachable production, a null
 * commit, a commit off this branch, a dirty tree, unpushed app code — without arranging an
 * out-of-date production, and with nothing applied. This file gathers; it does not judge.
 *
 * ── THE PIPE REFUSAL IS WANTED HERE ─────────────────────────────────────────────────────────────
 * _ts.mjs brings _gate-preflight in, which refuses a piped stdout. That is usually about gate
 * fixtures, and it is right for this too: a SIGPIPE part-way through `migrate deploy` is a migration
 * half applied to the shared database. Redirect to a file.
 */
import './_ts.mjs';
const { execFileSync } = await import('node:child_process');
const { readFileSync, writeFileSync, readdirSync, existsSync } = await import('node:fs');
const R = await import('../lib/migration-deploy-rules.ts');
// describeError leads with the error CLASS, so an error with no message still names itself.
const { describeError } = await import('./_gate-preflight.mjs');
const { readMarker } = await import('./_marker-read.mjs');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');

/**
 * ── APPLYING TO PRODUCTION IS A SENTENCE SOMEBODY TYPES ─────────────────────────────────────────
 * With one database this script applied to "the database", and that was the only one there was.
 * With two, the quiet default is wrong in both directions: pointed at the gate database it should
 * just work, and pointed at production it should make you say so.
 *
 * --yes-production --expect=<name[,name]>
 *   reads the connection from .migrate-target.production and NOT from .env, so the working file is
 *   never edited and there is no swap to forget to undo;
 *
 *   THE NAME IS DELIBERATELY OUTSIDE THE DOTENV NAMESPACE. The first draft called it
 *   .env.production.local, which Next AUTO-LOADS whenever NODE_ENV=production and which takes
 *   precedence over .env — so `npm run build` would have built against the live database while
 *   every other tool read the gate one. Proved with @next/env's own loader before renaming. Next
 *   looks for exactly .env.$(NODE_ENV).local, .env.local, .env.$(NODE_ENV) and .env; this is none
 *   of them, and prisma.config.ts's dotenv reads only .env;
 *   refuses unless that file names PRODUCTION — the flag is a statement of intent, and a mismatch
 *   means something is wrong rather than something is safe;
 *   refuses unless the pending set is EXACTLY --expect, so a second migration cannot ride along;
 *   prints the endpoint, the Environment kind and the pending list, then requires the endpoint id
 *   TYPED BACK from a terminal.
 *
 * The TTY requirement is the point of the design rather than a detail: with stdin not a terminal
 * it refuses outright, so this cannot be run from a script, from CI, or by an agent. It belongs to
 * a person at a keyboard.
 */
const YES_PRODUCTION = process.argv.includes('--yes-production');
const EXPECT = (() => {
  const a = process.argv.find((x) => x.startsWith('--expect='));
  return a ? a.slice('--expect='.length).split(',').map((x) => x.trim()).filter(Boolean) : null;
})();

if (YES_PRODUCTION) {
  const file = `${ROOT}/.migrate-target.production`;
  if (!existsSync(file)) {
    console.error(`\n  --yes-production needs ${file}, holding ONLY the production DATABASE_URL and DIRECT_URL.`);
    console.error('  Move those two lines out of .env rather than copying them, so there is one home for each.\n');
    process.exit(2);
  }
  if (!EXPECT?.length) {
    console.error('\n  --yes-production also needs --expect=<migration-name[,name]>.');
    console.error('  Naming what you expect to apply is what stops a second migration riding along.\n');
    process.exit(2);
  }
  // Only these two keys, and they REPLACE whatever .env put there. Last-wins, matching dotenv.
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const OVERRIDE = (() => {
  const a = process.argv.find((x) => x.startsWith('--even-if-not-live'));
  if (!a) return null;
  const reason = (a.split('=').slice(1).join('=') || '').trim().replace(/^["']|["']$/g, '');
  if (!reason) {
    console.error('\n--even-if-not-live needs a reason: --even-if-not-live="why this window is acceptable"');
    console.error('It is written into the migration file, where whoever looks in six months will find it.\n');
    process.exit(2);
  }
  return reason;
})();

/**
 * --defaults-are-db-backed="<reason>" — THE NARROW EXCEPTION, 2026-10-30.
 *
 * Clears the SCHEMA-DEFAULT blocker and nothing else. The liveness blockers, the classification
 * refusals and --expect are all untouched, and unlike --even-if-not-live this writes NOTHING into
 * any migration file — which matters now that every file is applied to two databases (the gate
 * split of 26 October), where an edit after the fact leaves the other ledger holding a stale
 * checksum.
 *
 * WHY IT IS NEEDED AT ALL: schemaRisk keeps every added line containing `@default(` and cannot see
 * that the SQL supplies a database DEFAULT, or that the table is one the same set CREATEs. Both
 * close the hazard completely — production can only break if it omits a value AND the database
 * rejects the omission. So the rule fires on a routine additive migration, and a guard that fires
 * on the ordinary case is how people learn to reach for the big override. Narrowing the rule to
 * the real hazard is boarded; until then the exception is stated, reasoned and printed.
 *
 * IT REFUSES WHEN THERE IS NOTHING TO CLEAR, deliberately: a flag that quietly does nothing is a
 * flag that ends up on every command line.
 */
const DEFAULTS_DB_BACKED = (() => {
  const a = process.argv.find((x) => x.startsWith('--defaults-are-db-backed'));
  if (!a) return null;
  const reason = (a.split('=').slice(1).join('=') || '').trim().replace(/^["']|["']$/g, '');
  if (!reason) {
    console.error('\n--defaults-are-db-backed needs a reason: --defaults-are-db-backed="why every added default is backed by a database DEFAULT or sits on a new table"');
    console.error('It is printed before applying, so an exception taken on the night is still read out loud.\n');
    process.exit(2);
  }
  return reason;
})();

/**
 * THE ONE TEST SEAM, AND WHY IT CANNOT BE ABUSED.
 *
 * migration-class-gate has to drive this script on migrations that are actually pending — a header
 * missing, a header disagreeing with its SQL — and it must not create those inside prisma/migrations,
 * where a stray `migrate deploy` from another terminal would apply them to the shared database.
 *
 * So the directory can be redirected, and the redirection REFUSES unless --dry-run is also set. The
 * seam therefore cannot apply anything, whatever anyone points it at. What that leaves unproved is
 * the `migrate deploy` call itself, and there is no honest way to prove that except by applying a
 * real migration — which the next real one will do.
 */
const MIGRATIONS_DIR = (() => {
  const override = process.env.MIGRATE_APPLY_DIR;
  if (!override) return `${ROOT}/prisma/migrations`;
  if (!DRY) {
    console.error('\nMIGRATE_APPLY_DIR is set without --dry-run. Refusing: that combination could apply migrations from outside the repo.\n');
    process.exit(2);
  }
  return override;
})();

/**
 * WHICH DATABASE THIS IS POINTED AT. Until 2026-10-26 the answer was always "the one production
 * reads", and every refusal below assumes it. There is a separate gate project now, so the
 * assumption is asked rather than made. `safe` is true only when BOTH urls are positively known to
 * be elsewhere — unknown counts as production, because the question is whether it is safe to
 * change this database and silence is not a yes. See scripts/_db-target.mjs.
 */
const { describeTarget } = await import('./_db-target.mjs');
const TARGET = describeTarget(ROOT);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };

function say(s = '') { console.log(s); }
function die(lines) {
  say('\n  REFUSED — nothing applied.\n');
  for (const l of lines) say(`  • ${l}\n`);
  say('  Either push the code and wait for production to report this commit, or fix the header.');
  say('  To accept the window deliberately: --even-if-not-live="<reason>"  (recorded in the migration file)\n');
  process.exit(2);
}

// ── 1. WHAT IS PENDING ──────────────────────────────────────────────────────────────────────────
// From the table, not from `migrate status` prose. A parser of sentences is one Prisma release away
// from reporting "nothing pending" on a schema full of them, and that failure direction is silent.
const { prisma } = await import('../lib/db.ts');
let pending;
try {
  // A VIRGIN DATABASE HAS NO LEDGER, and that is a legitimate state rather than a fault. The gate
  // project created on 2026-10-26 had zero tables, so this query failed 42P01 and the wrapper could
  // not bootstrap the one database it is actually safe to bootstrap. An empty applied set then
  // means "apply everything", which the refusal below permits ONLY off production.
  const applied = new Set(
    (await prisma.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
      .catch((e) => {
        const missing = String(e?.meta?.code ?? '') === '42P01'
          || /relation "_prisma_migrations" does not exist/.test(String(e?.message ?? ''));
        if (missing) return [];
        throw e;
      }))
      .map((r) => r.migration_name),
  );
  const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${MIGRATIONS_DIR}/${d.name}/migration.sql`))
    .map((d) => d.name)
    .sort();
  // NOT VACUOUS: if the applied set came back empty, every migration would read as pending and this
  // would refuse loudly rather than sail through. Said out loud because the opposite mistake — an
  // empty PENDING set from a failed read — is the one that would pass.
  // OFF PRODUCTION an empty ledger is a database waiting to be built. On production — or on a
  // target this cannot positively identify — it is the connection fault it has always been.
  if (!applied.size && !TARGET.safe) {
    die([`the database reports no applied migrations at all, and this target is not positively known to be `
      + `non-production (runtime ${TARGET.runtime} ${TARGET.runtimeEndpoint ?? '—'}, migrations `
      + `${TARGET.migrations} ${TARGET.migrationsEndpoint ?? '—'}). That is not a migration question; `
      + `stop and look at the connection.`]);
  }
  if (!applied.size) {
    say(`\n  VIRGIN DATABASE — no migrations applied yet, and the target is not production`);
    say(`  (runtime ${TARGET.runtimeEndpoint}, migrations ${TARGET.migrationsEndpoint}). Building it from zero.`);
  }
  pending = onDisk.filter((n) => !applied.has(n));
} finally {
  await prisma.$disconnect();
}

say(`\n  ${pending.length} migration(s) pending.`);
if (!pending.length) { say('  Nothing to apply.\n'); process.exit(0); }

// ── 2. CLASSIFY EACH ────────────────────────────────────────────────────────────────────────────
const classified = pending.map((name) => R.classifyMigration(name, readFileSync(`${MIGRATIONS_DIR}/${name}/migration.sql`, 'utf8')));
for (const m of classified) {
  say(`    ${m.name}`);
  say(`      declared ${m.declared ?? '—'} · SQL reads ${m.detected}${m.klass ? '' : '  ← REFUSES'}`);
  for (const r of m.reasons.slice(0, 4)) say(`      ${r}`);
  if (m.reasons.length > 4) say(`      …and ${m.reasons.length - 4} more`);
}

// ── 3. THE FACTS, IF ANY OF THEM CONSTRAIN ──────────────────────────────────────────────────────
const anyConstraining = classified.some((m) => m.klass === 'constraining');
let version = { ok: false, why: 'not asked — every pending migration is additive' };
let liveIsAncestor = null;
let appFilesNotLive = [];
let uncommittedAppFiles = [];
let schemaDefaults = [];
const head = gitOk('rev-parse', 'HEAD') ? git('rev-parse', 'HEAD') : '';

if (anyConstraining && classified.every((m) => m.klass)) {
  say('\n  A pending migration constrains an existing write. Asking production what it is running.');
  try {
    const res = await fetch(R.PRODUCTION_VERSION_URL, { signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) version = { ok: false, why: `${R.PRODUCTION_VERSION_URL} answered HTTP ${res.status}` };
    else {
      const b = await res.json();
      version = { ok: true, commit: b.commit ?? null, ref: b.ref ?? null, env: b.env ?? null, source: b.source ?? null };
      say(`    production: ${version.commit ? version.commit.slice(0, 12) : 'no commit'} on ${version.ref ?? '—'} (${version.env ?? '—'}, via ${version.source ?? '—'})`);
      say(`    this tree:  ${head.slice(0, 12)}`);
    }
  } catch (e) {
    version = { ok: false, why: `${R.PRODUCTION_VERSION_URL} — ${e?.name === 'TimeoutError' ? 'timed out' : String(e?.message ?? e)}` };
  }

  if (version.ok && version.commit) {
    // FETCH FIRST. Production may be running a commit pushed from elsewhere, or pushed before this
    // clone last looked; without the fetch that reads as "unknown commit" and refuses for the wrong
    // reason. A failed fetch is not fatal by itself — it only narrows what can be established.
    if (!gitOk('fetch', '--quiet', 'origin')) say('    (git fetch failed — working from what this clone already has)');
    if (!gitOk('cat-file', '-e', `${version.commit}^{commit}`)) liveIsAncestor = null;
    else liveIsAncestor = gitOk('merge-base', '--is-ancestor', version.commit, 'HEAD');

    if (liveIsAncestor === true) {
      appFilesNotLive = git('diff', '--name-only', `${version.commit}..HEAD`).split('\n').filter(Boolean).filter(R.comparedByDeployCheck);
      // RAW, NOT TRIMMED: porcelain's status field is two columns and an unstaged change begins with
      // a space, which the trimming git() helper would eat — see lib/migration-deploy-rules.
      uncommittedAppFiles = R.uncommittedPaths(
        execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      ).filter(R.comparedByDeployCheck);
      schemaDefaults = R.schemaRisk(git('diff', `${version.commit}..HEAD`, '--', 'prisma/schema.prisma'));
    }
  }
}

// ── THE FILE RULES APPLY EVERYWHERE; THE DEPLOY WINDOW DOES NOT ─────────────────────────────────
// First draft of the off-production branch sat ABOVE the classification and skipped it, which
// migration-class-gate caught: a headerless migration stopped being refused at all, because the
// gate drives this script against the gate database. The two rules are different things.
//
//   the HEADER rules are about the migration FILE — a missing header, or one that disagrees with
//   its own SQL, is a repo-discipline fault and is refused wherever it is applied.
//   the DEPLOY WINDOW is about the database PRODUCTION READS — "a constraining migration breaks
//   deployed writers" is meaningless where nothing is deployed.
const fileRefusals = classified.filter((m) => m.refusal).map((m) => `${m.name}: ${m.refusal}`);
if (fileRefusals.length) die(fileRefusals);

// ── OFF PRODUCTION, THE CEREMONY HAS NOTHING TO PROTECT ─────────────────────────────────────────
// Everything from here to the apply exists for ONE hazard, stated at the top of this file and in
// the hook: a migration is live the moment it is applied, while the code that honours it is live
// only when it deploys — so a constraining migration can break DEPLOYED WRITERS. That hazard is a
// property of the database PRODUCTION READS. On the gate database there is no deployed writer at
// all: nothing serves it, nothing reads it but this repo's own gates.
//
// Run against it, the classifier refuses almost the entire history — 250 migrations written before
// the `@migration:` header existed, read as constraining because they create unique indexes on
// tables that, on production, already held rows. Every one of those refusals is about a database
// this is not pointed at. A guard that refuses correct work because its premise expired is the
// shape that gets guards deleted.
//
// So the ceremony is SCOPED, not weakened: the production path below is untouched, and `safe` is
// true only when BOTH urls are positively known to be elsewhere.
if (TARGET.safe) {
  say(`  Target is NOT production (runtime ${TARGET.runtimeEndpoint}, migrations ${TARGET.migrationsEndpoint}).`);
  say('  Skipping the deploy-window check: it protects deployed writers, and this database has none.');
  // --dry-run STILL MEANS DRY. The first draft of this branch applied regardless, which would have
  // made the flag a lie on exactly the path somebody uses to look before leaping.
  // A DRY RUN FALLS THROUGH, deliberately. There is ONE dry-run message and one dry-run exit, at
  // section 5, and migration-class-gate drives this script with --dry-run to prove the positive
  // case — a clean additive migration passing classification and stopping. A second dry-run exit
  // here made that clause stop seeing it. Falling through costs nothing: on a dry run the window
  // ceremony below only prints, and a clean additive set never reaches its refusals anyway.
  if (!DRY) {
    applyNow();
    say('\n  APPLIED to the gate database. Production is untouched.\n');
    process.exit(0);
  }
}


// ── 4. THE DECISION ─────────────────────────────────────────────────────────────────────────────
const d = R.deployDecision({ pending: classified, version, liveIsAncestor, head, appFilesNotLive, uncommittedAppFiles, schemaDefaults, override: OVERRIDE, defaultsDbBacked: DEFAULTS_DB_BACKED });
if (!d.allow) die(d.refusals);

// A FLAG THAT CLEARED NOTHING IS A MISTAKE, NOT A NO-OP. Either the set changed since it was
// decided on, or it is being passed out of habit — and both are worth stopping for.
if (DEFAULTS_DB_BACKED && !d.defaultsAccepted) {
  // THE REMEDY IS TO REMOVE THE FLAG, said explicitly: die()'s generic footer offers
  // --even-if-not-live, which is the wrong answer to this refusal and the one somebody reaching
  // for a tidy ending at midnight would take.
  die(['--defaults-are-db-backed was given, but no schema-default blocker was raised.',
    'Nothing to clear means the facts have moved since the dry run that justified it.',
    'REMOVE THE FLAG and read the dry run again — the footer below is not the remedy for this one.']);
}
if (d.defaultsAccepted) {
  say('\n  SCHEMA DEFAULTS ACCEPTED — this blocker, and only this one:\n');
  for (const l of d.defaultsAccepted.lines) say(`    ${l}`);
  say(`\n  Reason given: ${d.defaultsAccepted.reason}\n`);
}

if (d.overridden) {
  say('\n  OVERRIDDEN with --even-if-not-live. What is being accepted:\n');
  for (const r of d.refusals) say(`    • ${r}\n`);
  say(`    reason: ${OVERRIDE}`);
  say('\n  Recording that in each constraining migration file, BEFORE applying — Prisma checksums');
  say('  migration.sql as it applies it, so a line added afterwards makes every later deploy refuse it.');
  for (const m of d.constraining) {
    const path = `${MIGRATIONS_DIR}/${m.name}/migration.sql`;
    const sql = readFileSync(path, 'utf8');
    if (R.hasOverrideNote(sql, version.ok ? version.commit : null)) { say(`    ${m.name}: already recorded for this production commit`); continue; }
    if (DRY) { say(`    ${m.name}: WOULD record the note`); continue; }
    writeFileSync(path, R.withOverrideNote(sql, d.note));
    say(`    ${m.name}: recorded`);
  }
} else if (anyConstraining) {
  say(`\n  Production is running this tree's app code. The window is closed; applying.`);
} else {
  say('\n  Every pending migration is additive — no deploy check needed.');
}

// ── 5. APPLY ────────────────────────────────────────────────────────────────────────────────────
// ONE PLACE THIS RUNS, and it is a hoisted declaration so the off-production branch far above can
// call it without a second execFileSync of its own. The first draft of that branch had its own
// copy, which migration-class-gate caught: its ordering clause reads the FIRST occurrence of this
// call and compares it against where the override note is written, so a duplicate above the note
// made a load-bearing invariant unreadable. Prisma checksums migration.sql as it applies it, so a
// note written afterwards makes every later deploy refuse the file.
function applyNow() {
  say('\n  → prisma migrate deploy\n');
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    say('\n  migrate deploy FAILED. The database may be part-applied; read the output above.\n');
    process.exit(1);
  }
}

if (DRY) { say('\n  DRY RUN — nothing applied, nothing written.\n'); process.exit(0); }

// ── THE PRODUCTION DOOR ─────────────────────────────────────────────────────────────────────────
if (TARGET.runtime === 'production' || TARGET.migrations === 'production') {
  if (!YES_PRODUCTION) {
    die([`this is PRODUCTION (runtime ${TARGET.runtimeEndpoint}, migrations ${TARGET.migrationsEndpoint}) `
      + 'and --yes-production was not given. Applying to production is a sentence somebody types.']);
  }
  const unexpected = pending.filter((n) => !EXPECT.includes(n));
  const absent = EXPECT.filter((n) => !pending.includes(n));
  if (unexpected.length || absent.length) {
    die([`the pending set is not what --expect named.`,
      unexpected.length ? `pending but not expected: ${unexpected.join(', ')}` : '',
      absent.length ? `expected but not pending: ${absent.join(', ')}` : ''].filter(Boolean));
  }
  // THE THREE ANSWERS live in _marker-read, so the same code can be run on its own against a
  // database with no Environment table. Inline, it was handed over having never executed: a
  // --dry-run exits before this point, so nothing here was covered by the run that "checked" it.
  const marker = await (async () => {
    const { prisma: p2 } = await import('../lib/db.ts');
    return (await readMarker(p2, describeError)).text;
  })();

  say('\n  ── APPLYING TO PRODUCTION ──────────────────────────────────────────────');
  say(`  file      .migrate-target.production`);
  say(`  endpoint  ${TARGET.migrationsEndpoint}  → PRODUCTION`);
  say(`  marker    Environment.kind = ${marker}`);
  say(`  pending   ${pending.join('\n            ')}`);
  say('');

  // A TYPED MATCH, FROM A TERMINAL. Not a y/n: a y/n is reflex, and the thing being guarded is the
  // database the business runs on. Not a terminal at all means not a person, so it refuses.
  if (!process.stdin.isTTY) {
    die(['stdin is not a terminal. --yes-production is for a person at a keyboard, not a script, CI, or an agent.']);
  }
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`  Type the endpoint id to apply, anything else to abort:\n  > `)).trim();
  rl.close();
  if (typed !== TARGET.migrationsEndpoint) {
    say(`\n  Aborted — "${typed}" is not ${TARGET.migrationsEndpoint}. Nothing applied.\n`);
    process.exit(1);
  }
}

applyNow();

// ── 6. AND THE SCHEMA FILE KEPT UP ──────────────────────────────────────────────────────────────
// The mistake in the other direction: the SQL written, applied, and schema.prisma never edited. The
// deploy check deliberately ignores schema.prisma (it cannot safely travel in push 1), so this is
// where forgetting it is caught — once applying has made the answer meaningful.
try {
  const diff = execFileSync('npx', ['prisma', 'migrate', 'diff', '--from-schema-datamodel', 'prisma/schema.prisma', '--to-schema-datasource', 'prisma/schema.prisma', '--script'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ddl = diff.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^--/.test(l) && !/^(Loaded Prisma config|Prisma config detected|Environment variables loaded)/.test(l))
    .filter((l) => !/^CREATE SCHEMA IF NOT EXISTS "public";?$/.test(l));
  if (ddl.length) {
    say(`\n  ⚠ prisma/schema.prisma and the database now DISAGREE — ${ddl.length} statement(s):`);
    for (const l of ddl.slice(0, 6)) say(`      ${l}`);
    say('    Edit schema.prisma to match what you just applied, then re-run schema-drift-gate.');
  }
} catch (e) { say(`\n  (could not check schema drift: ${String(e?.message ?? e).slice(0, 120)})`); }

say('\n  APPLIED — and live on the shared database this second.');
say('  Push the migration now. Until it is pushed, this database has a rule no pushed commit explains.\n');
