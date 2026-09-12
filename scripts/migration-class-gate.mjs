/**
 * File: scripts/migration-class-gate.mjs
 * A MIGRATION SAYS WHETHER IT CONSTRAINS AN EXISTING WRITE, AND THE SQL AGREES.
 * @gate-requires: db
 *
 * Dev and production share one database. A constraining migration is live the moment it is applied
 * and breaks production until the push lands — which is what happened on 2026-09-11, four hours of
 * 500s on every "No SMS" save. scripts/migrate-apply.mjs is the stop; this proves the stop.
 *
 * ── WHY THE RULES ARE PURE FUNCTIONS ────────────────────────────────────────────────────────────
 * Every refusal in lib/migration-deploy-rules.ts takes facts as arguments. So "production was
 * unreachable", "production answered with a null commit", "production is on another branch" are all
 * proved HERE, in milliseconds, with nothing applied and no out-of-date production to arrange. A
 * refusal that could only be tested by breaking production is a refusal nobody tests.
 *
 * ── WHAT THIS GATE NEVER DOES ───────────────────────────────────────────────────────────────────
 * Apply anything. The wrapper is driven with --dry-run, against FIXTURE migrations in a temp
 * directory — never inside prisma/migrations, where a stray `migrate deploy` from another terminal
 * would reach them. The one thing left unproved is the `prisma migrate deploy` call itself, which no
 * honest test can reach; the next real migration proves that.
 *
 * ── THE REPO SWEEP HAS NO SUBJECTS YET ──────────────────────────────────────────────────────────
 * The header became compulsory at HEADER_REQUIRED_AFTER, and nothing has been written since, so
 * sweeping the repo today finds nothing to check — "all clear" from a search with no subjects. So the
 * sweep is proved on fixtures that include a KNOWN BAD one first, and only then trusted on the repo.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
const { execFileSync } = await import('node:child_process');
const { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const R = await import('../lib/migration-deploy-rules.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const M = 'prisma/migrations';
const sqlOf = (n) => readFileSync(`${M}/${n}/migration.sql`, 'utf8');
const FIX = `${tmpdir()}/migration-class-gate-${process.pid}`;
const plant = (name, sql) => { mkdirSync(`${FIX}/${name}`, { recursive: true }); writeFileSync(`${FIX}/${name}/migration.sql`, sql); };
const runWrapper = (extraEnv = {}, args = ['--dry-run']) => {
  try { return execFileSync('node', ['scripts/migrate-apply.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GATE_ALLOW_PIPE: '1', ...extraEnv } }); }
  catch (e) { return `EXIT ${e.status}\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`; }
};

const prisma = await gatePrisma();
try {
  // ── 1. THE CLASSIFIER, ON THE MIGRATION THAT ACTUALLY BROKE PRODUCTION ───────────────────────
  console.log('\n— the real case, and a real additive one beside it —');
  const TRIGGER = '20260911090000_contact_preference_trigger';
  const ADDITIVE = '20260906180000_rep_public_phone';
  const trig = R.classifySql(sqlOf(TRIGGER));
  check(`${TRIGGER} reads constraining`, trig.detected === 'constraining', `${trig.reasons.length} reasons`);
  check('  …and BY THE TRIGGER RULE, not merely "not recognised"', trig.reasons.some((r) => /^TRIGGER —/.test(r)),
    'it yields four CREATE TRIGGER hits and three unrecognised function bodies; the right answer for the wrong reason would hide a dead pattern');
  const add = R.classifySql(sqlOf(ADDITIVE));
  check(`${ADDITIVE} reads additive — the positive case, same run`, add.detected === 'additive', add.reasons.join(' | ') || 'two nullable columns, nothing else');
  check('the dollar-quoted function bodies are ONE statement each, not twenty', R.statements(sqlOf(TRIGGER)).length === 7,
    `${R.statements(sqlOf(TRIGGER)).length} statements — a naive split on ";" shreds plpgsql and still answers "constraining", which is how it would survive`);

  console.log('\n— and each rule fires on its own —');
  const one = (sql) => R.classifySql(sql).reasons.map((r) => r.split(' —')[0].split('\n')[0]);
  for (const [what, sql, want] of [
    ['SET NOT NULL', 'ALTER TABLE "Customer" ALTER COLUMN "name" SET NOT NULL;', 'SET NOT NULL'],
    ['a unique index', 'CREATE UNIQUE INDEX "C_x_key" ON "Customer"("x");', 'UNIQUE INDEX'],
    ['a CHECK on an existing table', 'ALTER TABLE "Customer" ADD CONSTRAINT "c" CHECK (x > 0);', 'ADD CONSTRAINT'],
    ['a data rewrite', 'UPDATE "Customer" SET "x" = 1 WHERE "x" IS NULL;', 'UPDATE'],
    ['a deletion', 'DELETE FROM "Customer" WHERE "x" IS NULL;', 'DELETE'],
    ['a drop', 'ALTER TABLE "Customer" DROP COLUMN "x";', 'DROP'],
    ['a type change', 'ALTER TABLE "Customer" ALTER COLUMN "x" TYPE BIGINT;', 'ALTER COLUMN TYPE'],
    ['a rename', 'ALTER TABLE "Customer" RENAME COLUMN "x" TO "y";', 'RENAME'],
    ['an INSERT into an existing table', 'INSERT INTO "Customer" ("x") VALUES (1);', 'not recognised, so treated as constraining'],
  ]) check(`${what} alone is constraining`, one(sql)[0] === want, one(sql).join(', ') || '(nothing)');

  // THE ONE REFINEMENT PAST "AMBIGUITY IS CONSTRAINING", and the reason it is allowed: it is
  // decidable, not a judgement. Without it every new table with a foreign key costs a second push.
  const newTable = 'CREATE TABLE "Thing" ("id" TEXT NOT NULL, "cid" TEXT NOT NULL, CONSTRAINT "Thing_pkey" PRIMARY KEY ("id"), CONSTRAINT "Thing_c" CHECK (length("cid") > 0), CONSTRAINT "Thing_cid_fkey" FOREIGN KEY ("cid") REFERENCES "Customer"("id") ON DELETE CASCADE);';
  check('a NEW table\'s own CHECK and FOREIGN KEY are additive', R.classifySql(newTable).detected === 'additive',
    'they constrain inserts into a table production has never heard of — the commonest non-trivial migration there is');
  check('  …but the same CHECK hung on an existing table is not', R.classifySql('ALTER TABLE "Customer" ADD CONSTRAINT "c" CHECK (length("x") > 0);').detected === 'constraining',
    'the discriminator: whether the constrained rows could already exist');
  check('a non-unique index is additive, a unique one is not', R.classifySql('CREATE INDEX "i" ON "Customer"("x");').detected === 'additive'
    && R.classifySql('CREATE UNIQUE INDEX "i" ON "Customer"("x");').detected === 'constraining', 'an index rejects no write');

  // ── 2. THE HEADER, AND THE DISAGREEMENT ──────────────────────────────────────────────────────
  console.log('\n— the header —');
  const ADD_SQL = 'ALTER TABLE "Rep" ADD COLUMN "phone" TEXT;';
  const CON_SQL = 'ALTER TABLE "Customer" ALTER COLUMN "name" SET NOT NULL;';
  check('a well-formed additive header is accepted', R.classifyMigration('m', `-- @migration: additive\n${ADD_SQL}`).klass === 'additive');
  check('a well-formed constraining header is accepted', R.classifyMigration('m', `-- @migration: constraining existing rows may have a null name\n${CON_SQL}`).klass === 'constraining');
  check('no header REFUSES', R.classifyMigration('m', ADD_SQL).klass === null && /no "-- @migration:" header/.test(R.classifyMigration('m', ADD_SQL).refusal));
  check('a nonsense value REFUSES', R.classifyMigration('m', `-- @migration: probably-fine\n${ADD_SQL}`).klass === null);
  check('constraining WITHOUT a why REFUSES', R.classifyMigration('m', `-- @migration: constraining\n${CON_SQL}`).klass === null,
    'the why is the part a reader six months later needs');
  check('two headers REFUSE rather than the first one winning', R.classifyMigration('m', `-- @migration: additive\n-- @migration: constraining x\n${ADD_SQL}`).klass === null,
    'a file that declares itself twice was edited without being read');

  console.log('\n— and a disagreement refuses in BOTH directions, never picking a winner —');
  const wrongWayRound = R.classifyMigration('m', `-- @migration: additive\n${CON_SQL}`);
  check('header additive + SQL constraining REFUSES', wrongWayRound.klass === null && /the header says additive, the SQL reads constraining/.test(wrongWayRound.refusal));
  const overCautious = R.classifyMigration('m', `-- @migration: constraining being careful\n${ADD_SQL}`);
  check('header constraining + SQL additive ALSO refuses', overCautious.klass === null && /the header says constraining, the SQL reads additive/.test(overCautious.refusal),
    'the cautious direction is still a disagreement: either the classifier misread the SQL or the author misread their migration, and both want a human');
  check('  …and a classification refusal can never be overridden', (() => {
    const d = R.deployDecision({ pending: [wrongWayRound], version: { ok: true, commit: 'a'.repeat(40), ref: 'main', env: 'production', source: 'runtime' }, liveIsAncestor: true, head: 'a'.repeat(40), appFilesNotLive: [], uncommittedAppFiles: [], schemaDefaults: [], override: 'I am in a hurry' });
    return !d.allow && !d.overridden;
  })(), 'the override accepts a known window, not "we do not know what this migration does"');

  // ── 3. THE DEPLOY CHECK FAILS CLOSED, ON EVERY BRANCH ────────────────────────────────────────
  console.log('\n— the deploy check: "I could not tell" is never "it is safe" —');
  const CON = R.classifyMigration('m', `-- @migration: constraining existing rows may have a null name\n${CON_SQL}`);
  const ADDM = R.classifyMigration('m', `-- @migration: additive\n${ADD_SQL}`);
  const LIVE = 'a'.repeat(40);
  const base = { pending: [CON], version: { ok: true, commit: LIVE, ref: 'main', env: 'production', source: 'runtime' }, liveIsAncestor: true, head: 'b'.repeat(40), appFilesNotLive: [], uncommittedAppFiles: [], schemaDefaults: [], override: null };
  const decide = (o) => R.deployDecision({ ...base, ...o });
  check('production running this tree\'s app code ALLOWS', decide({}).allow, 'the positive case, in the same run as the refusals');
  check('an additive migration never asks at all', decide({ pending: [ADDM], version: { ok: false, why: 'not asked' } }).allow,
    'most migrations are additive; a check they do not need is a check that gets bypassed');
  for (const [what, o, want] of [
    ['production unreachable', { version: { ok: false, why: 'fetch failed' } }, /did not answer[\s\S]*unreachable production is not a safe production/],
    ['production answers with a null commit', { version: { ok: true, commit: null, ref: null, env: 'production', source: 'unknown' } }, /no commit[\s\S]*honest "I do not know"/],
    ['the live commit is unknown to this clone', { liveIsAncestor: null }, /does not have even after a fetch/],
    ['the live commit is not an ancestor of HEAD', { liveIsAncestor: false }, /not an ancestor of HEAD/],
    ['app code is uncommitted', { uncommittedAppFiles: ['pages/api/jobcard-details.ts'] }, /uncommitted, so it certainly is not live/],
    ['app code is committed but not pushed', { appFilesNotLive: ['pages/api/jobcard-details.ts'] }, /are not live yet/],
    ['schema.prisma adds a client-generated default', { schemaDefaults: ['token String @default(uuid())'] }, /client-generated default/],
  ]) {
    const d = decide(o);
    check(`${what} REFUSES`, !d.allow && d.refusals.some((r) => want.test(r)), (d.refusals[0] ?? 'ALLOWED').split('\n')[0].slice(0, 110));
  }

  console.log('\n— what the comparison ignores, and the hole that leaves —');
  check('prisma/migrations is ignored — under two pushes it is applied before it is pushed', !R.comparedByDeployCheck('prisma/migrations/20260911090000_x/migration.sql'));
  check('prisma/schema.prisma is ignored — it cannot safely travel in push 1', !R.comparedByDeployCheck('prisma/schema.prisma'),
    'tightening String? to String while the column is nullable makes production\'s client stricter than the database, and Prisma throws reading a null into a required field');
  check('  …and app code is NOT ignored', R.comparedByDeployCheck('pages/api/jobcard-details.ts') && R.comparedByDeployCheck('lib/contact-preferences.ts'));
  check('an ADDED @default is the hole, and it is checked', R.schemaRisk('+++ b/prisma/schema.prisma\n+  token String @default(uuid())\n   other String\n').length === 1);
  check('  …a REMOVED one is not — production would be the generous side', R.schemaRisk('-  token String @default(uuid())\n').length === 0);
  check('  …and an unrelated added line is not', R.schemaRisk('+  nickname String?\n').length === 0,
    'a field identical app code cannot reference changes no query production sends');

  // ── 4. THE OVERRIDE LEAVES A DURABLE RECORD ──────────────────────────────────────────────────
  console.log('\n— the override is recorded where it will be found —');
  const ov = decide({ appFilesNotLive: ['pages/api/jobcard-details.ts'], override: 'support call in progress, the fix needs the constraint now' });
  check('it allows, and says it was overridden', ov.allow && ov.overridden);
  check('the note carries production\'s commit, this tree\'s, the files and the reason',
    /@applied-ahead-of-deploy: \d{4}-/.test(ov.note) && ov.note.includes(LIVE) && ov.note.includes('b'.repeat(40))
    && /pages\/api\/jobcard-details\.ts/.test(ov.note) && /support call in progress/.test(ov.note),
    'whoever looks in six months wants to know which migrations were applied against an out-of-date production, and why');
  check('  …and it names the window as a window', /production ran code that did not/.test(ov.note) && /this is the window/.test(ov.note));
  const noted = R.withOverrideNote(`-- @migration: constraining x\n${CON_SQL}`, ov.note);
  check('it lands in the migration file, beside the declaration, as SQL comments', noted.split('\n')[1].startsWith('-- @applied-ahead-of-deploy')
    && noted.includes(CON_SQL) && R.statements(noted).length === 1, 'it travels with what it describes');
  check('a retried apply does not stack a second note', R.hasOverrideNote(noted, LIVE) && !R.hasOverrideNote(`-- @migration: constraining x\n${CON_SQL}`, LIVE));
  // THE ORDERING IS LOAD-BEARING: Prisma checksums migration.sql as it applies it, so a note appended
  // afterwards makes every later `migrate deploy` refuse the file as modified.
  // BOTH MUST BE PRESENT. As `a < b` alone this passed when the write was deleted outright: indexOf
  // returns -1, which sorts before everything. A vacuous clause about ordering is worse than none,
  // because the thing it guards is invisible in a diff.
  const w = readFileSync('scripts/migrate-apply.mjs', 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const writesNote = w.indexOf('writeFileSync(path, R.withOverrideNote');
  const applies = w.indexOf("execFileSync('npx', ['prisma', 'migrate', 'deploy']");
  check('the wrapper writes the note BEFORE it applies', writesNote >= 0 && applies >= 0 && writesNote < applies,
    `note written at ${writesNote}, applied at ${applies} — Prisma checksums the file as it applies it, so a line added after makes every later deploy refuse it`);

  // ── 5. THE SWEEP, PROVED ON A KNOWN BAD CASE BEFORE THE REPO ─────────────────────────────────
  console.log('\n— every migration written since the rule has a header that agrees with its SQL —');
  const sweep = (names, read) => names.filter(R.headerRequired).map((n) => R.classifyMigration(n, read(n))).filter((m) => m.refusal);
  const FIXTURES = { '29990101000000_good': `-- @migration: additive\n${ADD_SQL}`, '29990101000001_bad': ADD_SQL };
  const planted = sweep(Object.keys(FIXTURES), (n) => FIXTURES[n]);
  check('the sweep finds a planted header-less migration', planted.length === 1 && planted[0].name === '29990101000001_bad',
    'a sweep with no subjects reports "all clear" — so it finds a known case before it is trusted to report none');
  check('  …and passes the good one beside it', !sweep(['29990101000000_good'], (n) => FIXTURES[n]).length);
  const dirs = readdirSync(M, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(`${M}/${d.name}/migration.sql`)).map((d) => d.name);
  const subjects = dirs.filter(R.headerRequired);
  const bad = sweep(dirs, sqlOf);
  check(`the repo's ${subjects.length} post-rule migration(s) all pass`, bad.length === 0, bad.map((b) => b.refusal.split('\n')[0]).join(' | ') || `${dirs.length} on disk, ${dirs.length - subjects.length} grandfathered at or below ${R.HEADER_REQUIRED_AFTER}`);
  check('the cutoff grandfathers by NAME, so nothing has to be kept in step', R.headerRequired('20260911120001_anything') && !R.headerRequired(R.HEADER_REQUIRED_AFTER) && !R.headerRequired('20260906180000_rep_public_phone'),
    'a migration directory name is its own timestamp');

  // ── 6. THE WRAPPER IS THE ONLY DOOR ──────────────────────────────────────────────────────────
  console.log('\n— and the bare command is not left lying about —');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  check('package.json prisma:deploy routes through the wrapper', /migrate-apply\.mjs/.test(pkg.scripts['prisma:deploy']), pkg.scripts['prisma:deploy']);
  // THE SEARCH TERM HAS TO MATCH HOW THE COMMAND IS WRITTEN, NOT HOW IT IS SPOKEN. The first version
  // looked for `prisma +migrate +deploy`, which the wrapper's own execFileSync(['prisma','migrate',
  // 'deploy']) does not contain — so it found nothing, and "nothing else runs it" would have passed
  // on a repo full of callers. The non-vacuity clause is what surfaced that.
  const RUNS_DEPLOY = /migrate['"]?[\s,]+['"]?deploy/;
  const scanned = [
    ...readdirSync('scripts').filter((f) => /\.(mjs|js|ts|sh)$/.test(f)).map((f) => `scripts/${f}`),
    'package.json',
    ...(existsSync('.github/workflows') ? readdirSync('.github/workflows').map((f) => `.github/workflows/${f}`) : []),
  ];
  // COMMENTS DO NOT RUN. Half the scripts here explain in prose that migrations are "applied with
  // `migrate deploy`" — schema-drift-gate among them — and counting those as callers is a red that
  // teaches people to weaken the rule.
  const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--|#)/.test(l)).join('\n');
  const hits = scanned.filter((f) => RUNS_DEPLOY.test(code(readFileSync(f, 'utf8'))));
  check('the search finds the wrapper\'s own call', hits.includes('scripts/migrate-apply.mjs'),
    `${scanned.length} files scanned — a term that matches nothing would pass the next clause on a repo full of callers`);
  const callers = hits.filter((f) => f !== 'scripts/migrate-apply.mjs' && f !== 'scripts/migration-class-gate.mjs');
  check('  …and nothing else runs it', callers.length === 0, callers.join(', ') || 'one door');

  // ── 7. THE WRAPPER END TO END, ON REAL PENDING MIGRATIONS, APPLYING NOTHING ───────────────────
  console.log('\n— the wrapper refuses real pending migrations, and applies nothing —');
  plant('29990101000002_no_header', ADD_SQL);
  const noHeader = runWrapper({ MIGRATE_APPLY_DIR: FIX });
  check('a pending migration with no header is REFUSED, exit 2', /EXIT 2/.test(noHeader) && /no "-- @migration:" header/.test(noHeader) && /REFUSED — nothing applied/.test(noHeader),
    (noHeader.match(/REFUSED[^\n]*/) ?? ['(no refusal)'])[0]);
  rmSync(`${FIX}/29990101000002_no_header`, { recursive: true });
  plant('29990101000003_disagrees', `-- @migration: additive\n${CON_SQL}`);
  const dis = runWrapper({ MIGRATE_APPLY_DIR: FIX });
  check('a header disagreeing with its SQL is REFUSED, exit 2', /EXIT 2/.test(dis) && /the header says additive, the SQL reads constraining/.test(dis));
  rmSync(`${FIX}/29990101000003_disagrees`, { recursive: true });
  plant('29990101000004_additive', `-- @migration: additive\n${ADD_SQL}`);
  const ok = runWrapper({ MIGRATE_APPLY_DIR: FIX });
  check('a clean additive migration passes classification and stops at the dry run', !/EXIT/.test(ok)
    && /1 migration\(s\) pending/.test(ok) && /Every pending migration is additive/.test(ok) && /DRY RUN — nothing applied/.test(ok),
    'the positive case for the wrapper itself, in the same run');
  check('  …and it never asked production about an additive one', !/Asking production/.test(ok));
  const noDry = runWrapper({ MIGRATE_APPLY_DIR: FIX }, []);
  check('the test seam REFUSES without --dry-run, so it can never apply anything', /EXIT 2/.test(noDry) && /could apply migrations from outside the repo/.test(noDry));
  const real = runWrapper({});
  check('and against the real directory it reports nothing pending', /0 migration\(s\) pending/.test(real) && /Nothing to apply/.test(real),
    'read from _prisma_migrations, not from parsed prose');

  // ── 7b. THE REFUSAL'S OWN PATH PARSER ────────────────────────────────────────────────────────
  /**
   * Only ever exercised when the wrapper REFUSES, which is why it shipped broken: the git helper
   * trims, porcelain's status field is two columns, and an unstaged line begins with a SPACE — so
   * the first line lost a character and `prisma/schema.prisma` arrived as `risma/schema.prisma`,
   * matching no exclusion. The wrapper refused on the one file it exists to ignore and named a path
   * that is not on disk. A refusal is a report a human acts on.
   */
  console.log('\n— the paths a refusal names are real —');
  const PORCELAIN = ' M prisma/schema.prisma\nM  lib/db.ts\n?? scripts/new-gate.mjs\nR  old/name.ts -> new/name.ts\n';
  const parsed = R.uncommittedPaths(PORCELAIN);
  check('an unstaged first line keeps its whole path', parsed[0] === 'prisma/schema.prisma',
    `${parsed[0]} — the leading space is part of the format, not whitespace to trim`);
  check('  …a staged line too', parsed[1] === 'lib/db.ts');
  check('  …an untracked one too', parsed[2] === 'scripts/new-gate.mjs');
  check('  …and a rename yields the NEW path', parsed[3] === 'new/name.ts', parsed[3]);
  check('  …so the exclusions actually match', !R.comparedByDeployCheck(parsed[0]) && R.comparedByDeployCheck(parsed[1]),
    'schema.prisma excluded, app code compared — which the mangled path defeated');
  // AGAINST THE REAL THING: every path this repo's own status produces must exist on disk.
  const live = R.uncommittedPaths(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }));
  check('  …and every path from THIS repo\'s status exists on disk', live.every((f) => existsSync(f)),
    live.filter((f) => !existsSync(f)).join(', ') || `${live.length} path(s) checked`);

  // ── 8. THE HOOK: THE LAYER THAT WORKS AT 11PM ────────────────────────────────────────────────
  // The wrapper only protects the database if it is the thing that runs, and at eleven at night the
  // command that gets typed is the one in muscle memory.
  console.log('\n— the hook blocks the bare command, and nothing a person legitimately types —');
  const H = await import('./hooks/no-bare-migrate-deploy.mjs');
  for (const cmd of ['prisma migrate deploy', 'npx prisma migrate deploy', 'pnpm prisma migrate deploy',
    'cd /Users/hugh/Developer/greasedesk-core && npx prisma migrate deploy', 'npx prisma migrate dev',
    'npx prisma migrate reset --force', 'npx prisma db push']) {
    check(`blocked: ${cmd.length > 52 ? `${cmd.slice(0, 49)}…` : cmd}`, H.verdict(cmd) !== null, H.verdict(cmd) ?? 'ALLOWED');
  }
  for (const cmd of ['node scripts/migrate-apply.mjs', 'npm run prisma:deploy', 'npx prisma migrate status',
    'npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma',
    'npx prisma generate', 'grep -rn "prisma migrate deploy" docs/', 'git log --grep="prisma migrate deploy"']) {
    check(`allowed: ${cmd.length > 52 ? `${cmd.slice(0, 49)}…` : cmd}`, H.verdict(cmd) === null, H.verdict(cmd) ?? 'allowed');
  }
  check('  …the last two matter most: reading ABOUT the rule must not be blocked', H.verdict('grep -rn "prisma migrate deploy" docs/') === null,
    'a hook that blocks the search is a hook somebody removes, and removing it takes the protection with it');
  check('the refusal names the wrapper and what to type instead', /migrate-apply\.mjs --dry-run/.test(H.REFUSAL('prisma migrate deploy'))
    && /four hours of 500s/.test(H.REFUSAL('x')), 'a refusal that does not say what to do next gets worked around, not obeyed');
  // END TO END, through stdin, the way Claude Code will call it.
  const hook = (stdin) => {
    try { execFileSync('node', ['scripts/hooks/no-bare-migrate-deploy.mjs'], { input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); return { status: 0, err: '' }; }
    catch (e) { return { status: e.status, err: String(e.stderr ?? '') }; }
  };
  const blocked = hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npx prisma migrate deploy' } }));
  check('run as a hook on a real payload it exits 2 and explains itself', blocked.status === 2 && /BLOCKED/.test(blocked.err), `exit ${blocked.status}`);
  check('  …and allows the wrapper through', hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node scripts/migrate-apply.mjs' } })).status === 0);
  check('a hook that cannot parse its input FAILS OPEN', hook('not json at all').status === 0 && hook('').status === 0,
    'three layers protect this; a hook that breaks every Bash call is deleted within the hour and takes its layer with it');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    rmSync(FIX, { recursive: true, force: true });
    check('the fixture migrations are gone', !existsSync(FIX), 'they never lived inside prisma/migrations, so nothing could have applied them');
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
