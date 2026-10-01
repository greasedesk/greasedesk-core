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
const { readFileSync } = await import('node:fs');

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
  check('  …into Postgres 18, the version the source runs', has('image: postgres:18') && has('postgresql-client-18'));
  check('  …and fails the job on any difference', has('node scripts/backup-verify.mjs "manifest-$STAMP.json"'));
  check('the passphrase goes to gpg on a FILE DESCRIPTOR, never in argv', has('--passphrase-fd 0') && !has('--passphrase "$BACKUP_PASSPHRASE"'));
  check('the dump is encrypted before it leaves the runner', has('--symmetric --cipher-algo AES256') && has('db-$STAMP.dump.gpg'));
  check('the dump uses the DIRECT endpoint secret, not a pooled one',
    has('DATABASE_URL: ${{ secrets.BACKUP_DATABASE_URL }}') && has('--format=custom --no-owner --no-privileges'));
  check('nothing echoes a connection string or a passphrase', !/echo[^\n]*(DATABASE_URL|PASSPHRASE)/.test(wf));
  check('the job is scheduled AND runnable by hand — a backup you cannot rehearse is one nobody rehearses',
    has('  schedule:') && has('  workflow_dispatch:'));
  check('a failure keeps the manifests to read afterwards', has('if: failure()') && has('upload-artifact'));
} catch (e) {
  check('run completed', false, String(e?.stack ?? e).slice(0, 300));
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
