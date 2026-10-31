/**
 * File: scripts/backup-gate.mjs
 *
 * THE RESTORE CHECK ACTUALLY CATCHES A BAD RESTORE.
 *
 * The nightly job's whole value is the verification step: it restores the uploaded dump and asserts
 * the copy reproduces the source. If that comparison is blind, the job goes green every night while
 * the bucket fills with dumps nobody can use — the exact shape of failure backups are famous for.
 *
 * So the comparison is driven here with PLANTED manifests, each one a way a dump goes wrong: a table
 * missed, a table short, a document changed under matching counts, a schema at the wrong migration.
 * Pure — no database, no network. The workflow itself is checked for the properties that cannot be
 * unit-tested (it restores what it UPLOADED, it never prints a secret), and those are labelled as
 * source checks, because that is what they are.
 */
import './_gate-preflight.mjs';
const { readFileSync, existsSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const BC = await import(`${R}/scripts/_backup-compare.mjs`);

try {
  const golden = { invoices: 46, lines: 83, grossPence: 1563883, sha256: 'f150133f1a52d822e7d6df2b3d5ac8584cc6e54c2a7545a5ababd5888d73b1c2' };
  const source = { tables: { Invoice: 1985, JobCard: 3140, Customer: 1901, AuditLog: 38004 }, totalRows: 45030, migrations: 236, juneGolden: golden };
  const clone = () => JSON.parse(JSON.stringify(source));

  console.log('— A FAITHFUL RESTORE PASSES —');
  const same = BC.compareManifests(source, clone());
  check('identical manifests verify', same.ok && same.problems.length === 0, JSON.stringify(same.problems));

  console.log('\n— AND EVERY WAY A DUMP GOES WRONG DOES NOT —');
  const missing = clone(); delete missing.tables.AuditLog;
  const r1 = BC.compareManifests(source, missing);
  check('a table missing from the restored copy fails, and is NAMED', !r1.ok && r1.problems.some((p) => /AuditLog is in the source and NOT/.test(p)), r1.problems.join('; '));
  const short = clone(); short.tables.Invoice = 1984;
  const r2 = BC.compareManifests(source, short);
  check('one row short fails, with both numbers', !r2.ok && r2.problems.some((p) => p.includes('Invoice: source 1985 rows, restored 1984')), r2.problems.join('; '));
  const extra = clone(); extra.tables.Leftover = 3;
  check('a table the source never had fails too — a restore into a dirty database', !BC.compareManifests(source, extra).ok);
  /** COUNTS CAN MATCH WHILE THE DOCUMENTS DIFFER. That is what the hash is for. */
  const edited = clone(); edited.juneGolden = { ...golden, sha256: 'deadbeef'.repeat(8) };
  const r3 = BC.compareManifests(source, edited);
  check('June documents that differ fail even when every count matches', !r3.ok && r3.problems.some((p) => /June golden sha256/.test(p)), r3.problems.join('; '));
  const money = clone(); money.juneGolden = { ...golden, grossPence: 1563882 };
  check('  …and a penny of June gross is a failure', !BC.compareManifests(source, money).ok);
  const mig = clone(); mig.migrations = 235;
  check('a schema at the wrong migration fails', !BC.compareManifests(source, mig).ok);
  check('a manifest that is missing entirely fails rather than passing vacuously', !BC.compareManifests(source, null).ok && !BC.compareManifests(null, source).ok);
  const empty = BC.compareManifests({ tables: {}, juneGolden: golden, migrations: 236 }, { tables: {}, juneGolden: golden, migrations: 236 });
  check('two EMPTY manifests do not verify — nothing compared is not a pass', !empty.ok, JSON.stringify(empty.problems));
  check('every problem is reported, not the first', BC.compareManifests(source, { tables: { Invoice: 1 }, migrations: 1, juneGolden: {} }).problems.length >= 6);

  console.log('\n— A TRUNCATED DUMP THAT STILL RESTORES —');
  check('half of last night’s size fails', !BC.sizeVerdict(2_000_000, 5_362_752).ok);
  check('  …a normal night passes', BC.sizeVerdict(5_400_000, 5_362_752).ok);
  check('  …growth passes', BC.sizeVerdict(9_000_000, 5_362_752).ok);
  check('the first ever run is silent rather than inventing a floor', BC.sizeVerdict(5_362_752, 0).ok);

  console.log('\n— RETENTION PREFIX —');
  check('the 1st of the month is monthly', BC.retentionPrefix(new Date('2026-11-01T02:17:00Z')) === 'monthly');
  check('a Sunday is weekly', BC.retentionPrefix(new Date('2026-10-04T02:17:00Z')) === 'weekly');
  check('any other day is nightly', BC.retentionPrefix(new Date('2026-10-06T02:17:00Z')) === 'nightly');
  check('a Sunday that is also the 1st is monthly — the longer retention wins', BC.retentionPrefix(new Date('2026-11-01T02:17:00Z')) === 'monthly');

  console.log('\n— THE WORKFLOW ITSELF —');
  // SOURCE CHECKS, labelled: these properties live in YAML that cannot be run here. They are the two
  // that would silently gut the job — verifying a local file instead of the uploaded one, and the
  // passphrase reaching a command line where every process on the runner can read it.
  const wf = readFileSync(`${R}/.github/workflows/nightly-backup.yml`, 'utf8');
  // Matched as EXACT TEXT, not patterns: these are YAML lines, and a key matcher written for JS objects
  // would both miss them and trip the suite's own anchoring rule.
  const has = (t) => wf.includes(t);
  check('the verify step restores what it DOWNLOADED from the bucket',
    has('aws s3 cp "s3://$R2_BUCKET/$PREFIX/db-$STAMP.dump.gpg" "roundtrip.dump.gpg"') && has('rm -f "db-$STAMP.dump"'),
    'verifying the local file would say nothing about what reached R2');
  // ONE NUMBER, ASSERTED AS AN AGREEMENT. The workflow now derives the package, the PATH and its own
  // version check from a single PGMAJOR, so the literal 'postgresql-client-18' is no longer in the
  // file — and matching that literal is all this clause used to do. What it is REALLY about is that
  // the client, the restore container and the source's major are the same number: pg_dump refuses a
  // server newer than itself, and a dump restored by an OLDER server is not the thing we promise to
  // be able to restore. Still pinned to 18 as well, because that is the source's major today and all
  // three have to move together when Neon's does.
  const pgMajor = wf.match(/PGMAJOR=(\d+)/)?.[1];
  // lib/anchored-match's keyRegex is built for JS/TS object literals and would not match a YAML
  // mapping — the same reason the exact-text matchers above do not use it, stated further up. The
  // waiver has to sit on the line DIRECTLY above the matcher, so it is the last comment line here.
  // @anchored-ok: `image: postgres:<n>` is a YAML line in a workflow file, not a JS object key
  const verifyImage = wf.match(/image: postgres:(\d+)/)?.[1];
  check('  …into Postgres 18, the version the source runs',
    !!pgMajor && pgMajor === verifyImage && pgMajor === '18' && has('"postgresql-client-${PGMAJOR}"'),
    `client ${pgMajor ?? '(no PGMAJOR)'} / restore container ${verifyImage ?? '(none)'}`);
  check('  …and fails the job on any difference', has('node scripts/backup-verify.mjs "manifest-$STAMP.json"'));
  check('the passphrase goes to gpg on a FILE DESCRIPTOR, never in argv', has('--passphrase-fd 0') && !has('--passphrase "$BACKUP_PASSPHRASE"'));
  check('the dump is encrypted before it leaves the runner', has('--symmetric --cipher-algo AES256') && has('db-$STAMP.dump.gpg'));
  check('the dump uses the DIRECT endpoint secret, not a pooled one',
    has('DATABASE_URL: ${{ secrets.BACKUP_DATABASE_URL }}') && has('--format=custom --no-owner --no-privileges'));
  // NARROWED TO THE HAZARD, WHICH IS A VALUE AND NOT A NAME. The preflight step reports WHICH
  // secrets the job can see, and names them in its ::error:: lines — that is the entire point of it,
  // and a rule forbidding the NAME forbids saying which secret is missing. What must never reach a
  // public log is an EXPANSION: `echo "$DATABASE_URL"`, `echo "${BACKUP_PASSPHRASE}"`. The $ sigil
  // is the difference between naming a secret and disclosing one, so that is what this matches.
  // Red-proved against both planted forms — narrowing a safety rule without re-proving it is how a
  // rule becomes decoration.
  check('nothing echoes a connection string or a passphrase',
    !/echo[^\n]*\$\{?(?:BACKUP_)?(?:DATABASE_URL|PASSPHRASE)/.test(wf));
  check('the job is scheduled AND runnable by hand — a backup you cannot rehearse is one nobody rehearses',
    has('  schedule:') && has('  workflow_dispatch:'));
  check('a failure keeps the manifests to read afterwards', has('if: failure()') && has('upload-artifact'));

  // ── THE REPORT STEPS CAN ACTUALLY RUN ───────────────────────────────────────────────────────────
  // Nineteen consecutive nights (12–31 Oct 2026) backed up, verified, and recorded nothing: both
  // report steps exited 2 on `REFUSING TO RUN — stdout is a pipe`, because backup-report.mjs imports
  // _ts.mjs for TypeScript and _ts.mjs imports _gate-preflight.mjs, whose guard refuses a pipe — and
  // in Actions a step's stdout is ALWAYS a pipe. The failure reporter was refused too, so a genuinely
  // bad night would have looked identical. Nothing in this gate noticed, which is why these clauses
  // exist.
  //
  // PINNED TO THE PREMISE, NOT THE FLAG. The demand for GATE_ALLOW_PIPE holds only while the script
  // still inherits that guard. Separating the TS loader from the gate preflight is on the board; when
  // it lands this clause's premise goes false and it stops asking for a flag that no longer does
  // anything, rather than outliving its hazard as a line nobody dares remove.
  const chainToGuard = (entry) => {
    const seen = new Set();
    const walk = (f) => {
      if (seen.has(f) || !existsSync(`${R}/scripts/${f}`)) return false;
      seen.add(f);
      if (f === '_gate-preflight.mjs') return true;
      // COMMENTS STRIPPED FIRST. Without this the tracer counted `// import './_gate-preflight.mjs'`
      // as an import, so the premise read "still inherits the guard" with the edge commented out —
      // the premise branch could never be reached and its red-proof passed for the wrong reason.
      const src = readFileSync(`${R}/scripts/${f}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      return [...src.matchAll(/from\s+'\.\/([^']+)'|import\s+'\.\/([^']+)'/g)]
        .map((m) => m[1] ?? m[2])
        .some(walk);
    };
    return walk(entry);
  };
  const inheritsGuard = chainToGuard('backup-report.mjs');
  // Steps are split on the list marker so a flag set on a DIFFERENT step cannot satisfy this.
  // Comments stripped from each block for the same reason as in the tracer above: a `#` line
  // MENTIONING the flag is not a step setting it, and a block carries the comments written above the
  // step that follows it. The first version of this clause counted one of those comments and printed
  // "1 of 2" when the true answer was 0 of 2 — the assertion was right and its own number was not.
  const steps = wf.split(/\n      - (?=name:|uses:)/).slice(1).map((b) => b.replace(/^[ \t]*#.*$/gm, ''));
  // These three matchers read YAML mapping keys in a workflow file, not JS object keys — the same
  // reason the exact-text matchers further up do not use lib/anchored-match, and each waiver has to
  // be the LAST comment line before its matcher.
  // @anchored-ok: `name:` is a YAML mapping key in a workflow file, not a JS object key
  const reportSteps = steps.filter((b) => /^name: Report the /.test(b));
  // Matched WITH its value: a bare name would also match the `#` lines that explain the flag, which
  // is the 0-of-2 mistake recorded above.
  // @anchored-ok: `GATE_ALLOW_PIPE:` is a YAML mapping key in a workflow step's `env:`
  const setsFlag = (b) => /GATE_ALLOW_PIPE: '1'/.test(b);
  check('both report steps are found in the workflow — the ones that write the BackupRun row',
    reportSteps.length === 2, `found ${reportSteps.length}: ${steps.filter((b) => b.startsWith('name:')).length} named steps in all`);
  check(inheritsGuard
    ? '  …and each sets GATE_ALLOW_PIPE, because the TS loader still drags in the pipe guard'
    : '  …and the TS loader no longer chains to the pipe guard, so no flag is required (premise expired)',
    inheritsGuard
      ? reportSteps.length === 2 && reportSteps.every(setsFlag)
      : true,
    inheritsGuard
      ? `${reportSteps.filter(setsFlag).length} of ${reportSteps.length} carry it — without it the step exits 2 and the row is never written`
      : 'backup-report.mjs no longer reaches _gate-preflight.mjs');
  check('  …and both still carry the address and the token, or the script exits 0 writing nothing',
    // @anchored-ok: two YAML mapping keys in a workflow step's `env:`, as above
    reportSteps.length === 2 && reportSteps.every((b) => /BACKUP_RUN_URL:/.test(b) && /BACKUP_RUN_TOKEN:/.test(b)),
    'an unconfigured report is a deliberate no-op, so a missing name is silent');
  // The flag must stay on the two steps that need it. Set job-wide or workflow-wide it would also
  // cover any future step — a gate among them — and switch off a protection this file cannot see.
  // Comments stripped here too — the header above `steps:` DESCRIBES this flag, and a clause that
  // reddens because the file explains itself teaches people not to explain things.
  const beforeFirstStep = wf.slice(0, wf.indexOf('    steps:')).replace(/^[ \t]*#.*$/gm, '');
  check('GATE_ALLOW_PIPE is per-step, never job-wide — it must not blanket a step added later',
    !beforeFirstStep.includes('GATE_ALLOW_PIPE'));
} catch (e) {
  check('run completed', false, String(e?.stack ?? e).slice(0, 300));
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
