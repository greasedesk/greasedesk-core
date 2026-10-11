/**
 * File: lib/backup-runs.ts
 *
 * WHETHER THE BACKUPS ARE WORKING — as pure functions of the rows, so a gate can ask without a
 * database and the screen and the API cannot disagree about the answer.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * Eleven consecutive nights failed in September. Each one left a red GitHub Actions run and nothing
 * else, so the only thing standing between a lost database and a noticed problem was somebody
 * remembering to look at a tab. The rows are the record; `backupHealth` is the sentence a person
 * reads, and it is deliberately the loudest thing on the screen when it is bad.
 *
 * ── A LIST IS NOT A VERDICT ─────────────────────────────────────────────────────────────────────
 * A log of twenty rows where the last nineteen failed looks, at a glance, exactly like a log of
 * twenty rows where they succeeded: both are a list of dates. So the verdict is computed, not left
 * to the reader, and it is computed from the LAST VERIFIED run rather than the last run — a failure
 * after a good night is a different situation from a failure after ten.
 */

/** Every value `BackupRun.outcome` can hold. Total by construction: a reader that does not know a
 *  value must say so rather than treat it as a success. */
export const BACKUP_OUTCOMES = ['verified', 'failed'] as const;
export type BackupOutcome = (typeof BACKUP_OUTCOMES)[number];
export const isBackupOutcome = (v: unknown): v is BackupOutcome =>
  (BACKUP_OUTCOMES as readonly string[]).includes(String(v));

/**
 * VERIFIED MEANS A RESTORE PROVED IT. The nightly workflow pulls the encrypted dump back DOWN from
 * R2, decrypts it, `pg_restore`s it into a throwaway Postgres and compares a fixed historical
 * month's invoice count, line count, gross and hash against the source. Nothing here calls a run
 * verified because an upload returned 200 — that was true on several of the eleven nights.
 */
export const VERIFIED_MEANS =
  'The encrypted file was downloaded back from the bucket, decrypted, restored into an empty database, '
  + 'and a fixed month of invoices matched the source exactly — count, lines, total and hash.';

export type RunRow = {
  stamp: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string;
  failed_step: string | null;
  bytes: bigint | number | null;
  table_count: number | null;
  total_rows: number | null;
};

export type Health =
  /** No row has ever been written. NOT the same as failing: nothing has been attempted, or the
   *  reporting itself is not wired up, and those need different actions. */
  | { state: 'none' }
  | { state: 'ok'; lastVerified: Date; hoursSince: number }
  /** Verified at some point, but not recently enough to be comfortable. */
  | { state: 'stale'; lastVerified: Date; hoursSince: number; consecutiveFailures: number }
  /** Failing now. `lastVerified` may be null — nothing has ever worked. */
  | { state: 'failing'; lastVerified: Date | null; hoursSince: number | null; consecutiveFailures: number };

/** A nightly job is late once it has missed well over a day; two missed nights is not a blip. */
export const STALE_AFTER_HOURS = 36;

export function backupHealth(runs: readonly RunRow[], now: Date): Health {
  if (!runs.length) return { state: 'none' };
  const byNewest = [...runs].sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
  const lastVerifiedRow = byNewest.find((r) => r.outcome === 'verified') ?? null;
  const lastVerified = lastVerifiedRow?.started_at ?? null;
  const hoursSince = lastVerified ? Math.floor((now.getTime() - lastVerified.getTime()) / 3_600_000) : null;

  // Counted from the newest backwards, so it answers "how long has this been broken" rather than
  // "how many failures are in the table".
  let consecutiveFailures = 0;
  for (const r of byNewest) {
    if (r.outcome === 'verified') break;
    consecutiveFailures += 1;
  }

  if (consecutiveFailures > 0) return { state: 'failing', lastVerified, hoursSince, consecutiveFailures };
  if (hoursSince !== null && hoursSince > STALE_AFTER_HOURS) {
    return { state: 'stale', lastVerified: lastVerified as Date, hoursSince, consecutiveFailures };
  }
  return { state: 'ok', lastVerified: lastVerified as Date, hoursSince: hoursSince ?? 0 };
}

/** The sentence a person reads. Names the number of nights, because "backup failed" reads as one. */
export function healthSentence(h: Health): string {
  switch (h.state) {
    case 'none':
      return 'No backup has ever reported in. Either none has run, or the nightly job cannot reach this site to say so.';
    case 'ok':
      return `Last verified backup ${h.hoursSince === 0 ? 'less than an hour ago' : `${h.hoursSince} hour${h.hoursSince === 1 ? '' : 's'} ago`}.`;
    case 'stale':
      return `The last verified backup was ${Math.floor(h.hoursSince / 24)} day${Math.floor(h.hoursSince / 24) === 1 ? '' : 's'} ago. A backup runs every night, so something has stopped reporting.`;
    case 'failing':
      return h.lastVerified
        ? `${h.consecutiveFailures} backup${h.consecutiveFailures === 1 ? '' : 's'} in a row have failed. The last one that was verified ran ${Math.floor((h.hoursSince as number) / 24)} day${Math.floor((h.hoursSince as number) / 24) === 1 ? '' : 's'} ago.`
        : `${h.consecutiveFailures} backup${h.consecutiveFailures === 1 ? '' : 's'} have failed and not one has ever been verified.`;
  }
}

/** Whether the verdict should be shown as a problem rather than a reassurance. */
export const isBad = (h: Health): boolean => h.state !== 'ok';

export type Submission = {
  stamp: string; startedAt: string; finishedAt?: string | null; outcome: string;
  failedStep?: string | null; objectKey?: string | null; bytes?: number | string | null;
  sha256?: string | null; databaseName?: string | null; tableCount?: number | null;
  totalRows?: number | null; migrations?: number | null; pgVersion?: string | null; golden?: unknown;
};

/**
 * WHAT THE ENDPOINT WILL ACCEPT. A refusal here is better than a row that reads as a backup and is
 * not one: a 'verified' outcome with no object key describes a file nobody can point at, and a
 * stamp is the idempotency key, so a blank one would record every retry as a separate night.
 */
export function submissionRefusal(s: Partial<Submission>): string | null {
  if (!s.stamp?.trim()) return 'stamp is required — it identifies the night and keeps a retried step from recording twice';
  if (!/^[0-9A-Za-z._-]{4,64}$/.test(s.stamp)) return 'stamp must be 4-64 characters of letters, digits, dot, dash or underscore';
  if (!s.startedAt || Number.isNaN(Date.parse(s.startedAt))) return 'startedAt must be an ISO timestamp';
  if (s.finishedAt && Number.isNaN(Date.parse(s.finishedAt))) return 'finishedAt must be an ISO timestamp when present';
  if (!isBackupOutcome(s.outcome)) return `outcome must be one of ${BACKUP_OUTCOMES.join(', ')}`;
  if (s.outcome === 'verified') {
    if (!s.objectKey?.trim()) return 'a verified run must name the object it verified';
    if (!s.finishedAt) return 'a verified run must say when it finished';
    if (!(Number(s.bytes) > 0)) return 'a verified run must carry the size of the file it verified';
  }
  if (s.outcome === 'failed' && !s.failedStep?.trim()) return 'a failed run must name the step that failed, or the row says only that something went wrong';
  if (s.sha256 && !/^[0-9a-f]{64}$/.test(s.sha256)) return 'sha256 must be 64 lowercase hex characters';
  return null;
}

/**
 * THE PAYLOAD THE WORKFLOW SENDS, assembled from the manifest the dump already produced rather than
 * from facts restated in YAML. Pure so a gate can check it: the shape is the only thing standing
 * between a green night and a row that says a backup happened when it did not.
 *
 * `golden` carries the comparison itself, not a verdict about it, so a later reader can disagree
 * with tonight's conclusion using tonight's numbers.
 */
export function assembleSubmission(a: {
  stamp: string;
  startedAt: Date | string;
  finishedAt?: Date | string | null;
  outcome: BackupOutcome;
  failedStep?: string | null;
  objectKey?: string | null;
  bytes?: number | null;
  sha256?: string | null;
  pgVersion?: string | null;
  /** The parsed manifest-<STAMP>.json, or null when the run failed before producing one. */
  manifest?: { database?: string; tables?: Record<string, number>; totalRows?: number; migrations?: number; juneGolden?: unknown } | null;
}): Submission {
  const m = a.manifest ?? null;
  const iso = (d: Date | string | null | undefined) => (d == null ? null : typeof d === 'string' ? d : d.toISOString());
  return {
    stamp: a.stamp,
    startedAt: iso(a.startedAt) as string,
    finishedAt: iso(a.finishedAt),
    outcome: a.outcome,
    failedStep: a.failedStep ?? null,
    objectKey: a.objectKey ?? null,
    bytes: a.bytes ?? null,
    sha256: a.sha256 ?? null,
    databaseName: m?.database ?? null,
    // A table count of 0 is a real and alarming measurement; `?? null` keeps it, where `|| null`
    // would turn an empty database into "we did not measure".
    tableCount: m?.tables ? Object.keys(m.tables).length : null,
    totalRows: m?.totalRows ?? null,
    migrations: m?.migrations ?? null,
    pgVersion: a.pgVersion ?? null,
    golden: m?.juneGolden ?? null,
  };
}
