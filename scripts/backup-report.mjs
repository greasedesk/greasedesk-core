/**
 * File: scripts/backup-report.mjs
 * Reports one nightly backup attempt to pages/api/backup-run. Called by the workflow, twice:
 * once on success and once in an `if: failure()` step, which is the half that matters — eleven
 * failed nights reported nothing at all.
 *
 * Reads the manifest the dump already produced rather than restating its facts in YAML, and sends
 * the shape lib/backup-runs::assembleSubmission builds. Never prints the token.
 *
 *   node scripts/backup-report.mjs verified|failed [failed-step]
 */
import './_ts.mjs';
const { readFileSync, statSync, existsSync } = await import('node:fs');
const { assembleSubmission, submissionRefusal } = await import('../lib/backup-runs.ts');

const outcome = process.argv[2];
const failedStep = process.argv[3] ?? null;
const { STAMP, BACKUP_RUN_URL, BACKUP_RUN_TOKEN, BACKUP_OBJECT_KEY, BACKUP_STARTED_AT, PGMAJOR } = process.env;

if (!STAMP) { console.error('backup-report: STAMP is not set'); process.exit(2); }
if (!BACKUP_RUN_URL || !BACKUP_RUN_TOKEN) {
  // NOT a hard failure: a backup that worked must not be reported as broken because the reporting
  // is unconfigured. It says so loudly instead, and the screen's 'none' state says the same thing.
  //
  // "LOUDLY" WAS A console.error IN A LOG NOBODY OPENS, and that is how BackupRun came to hold no
  // row for its entire existence: green job, successful dump, successful restore-verify, and this
  // line scrolling past in the middle of a step. A GitHub warning annotation surfaces on the run
  // summary and in the Actions list, which is where somebody actually looks.
  const which = [!BACKUP_RUN_URL && 'BACKUP_RUN_URL', !BACKUP_RUN_TOKEN && 'BACKUP_RUN_TOKEN'].filter(Boolean).join(' and ');
  console.log(`::warning::${which} is not set — this backup ran but NOTHING was recorded in the app, so the Engine Room's backup screen still shows nothing.`);
  console.error(`backup-report: ${which} is not set — the backup is not reported`);
  process.exit(0);
}

const manifestPath = `manifest-${STAMP}.json`;
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const localFile = ['roundtrip.dump.gpg', `db-${STAMP}.dump.gpg`].find((f) => existsSync(f));

const payload = assembleSubmission({
  stamp: STAMP,
  startedAt: BACKUP_STARTED_AT || new Date().toISOString(),
  finishedAt: outcome === 'verified' ? new Date().toISOString() : null,
  outcome,
  failedStep,
  objectKey: BACKUP_OBJECT_KEY ?? null,
  bytes: localFile ? statSync(localFile).size : null,
  pgVersion: PGMAJOR ? `pg${PGMAJOR}` : null,
  manifest,
});

const refusal = submissionRefusal(payload);
if (refusal) { console.error(`backup-report: would be refused — ${refusal}`); process.exit(1); }

const res = await fetch(BACKUP_RUN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${BACKUP_RUN_TOKEN}` },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log(`backup-report: HTTP ${res.status} ${text.slice(0, 200)}`);
process.exit(res.ok ? 0 : 1);
