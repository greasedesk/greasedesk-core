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

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');
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
  const applied = new Set(
    (await prisma.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'))
      .map((r) => r.migration_name),
  );
  const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${MIGRATIONS_DIR}/${d.name}/migration.sql`))
    .map((d) => d.name)
    .sort();
  // NOT VACUOUS: if the applied set came back empty, every migration would read as pending and this
  // would refuse loudly rather than sail through. Said out loud because the opposite mistake — an
  // empty PENDING set from a failed read — is the one that would pass.
  if (!applied.size) die(['the database reports no applied migrations at all. That is not a migration question; stop and look at the connection.']);
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
      uncommittedAppFiles = git('status', '--porcelain')
        .split('\n').filter(Boolean)
        .map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))
        .filter(R.comparedByDeployCheck);
      schemaDefaults = R.schemaRisk(git('diff', `${version.commit}..HEAD`, '--', 'prisma/schema.prisma'));
    }
  }
}

// ── 4. THE DECISION ─────────────────────────────────────────────────────────────────────────────
const d = R.deployDecision({ pending: classified, version, liveIsAncestor, head, appFilesNotLive, uncommittedAppFiles, schemaDefaults, override: OVERRIDE });
if (!d.allow) die(d.refusals);

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
if (DRY) { say('\n  DRY RUN — nothing applied, nothing written.\n'); process.exit(0); }
say('\n  → prisma migrate deploy\n');
try {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  say('\n  migrate deploy FAILED. The database may be part-applied; read the output above.\n');
  process.exit(1);
}

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
