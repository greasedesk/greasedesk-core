/**
 * File: pages/api/backup-run.ts
 * The nightly backup workflow reports here. One row per attempt, keyed on the run's stamp.
 *
 * ── WHY AN ENDPOINT AND NOT A DATABASE WRITE FROM CI ────────────────────────────────────────────
 * The workflow already holds a connection string to take the dump, and could insert the row itself.
 * It should not: that credential exists to READ the database for one command, and widening CI's
 * reach to arbitrary writes to buy one INSERT is the wrong trade. This endpoint accepts exactly one
 * shape, validates it in lib/backup-runs, and can write nothing else.
 *
 * ── ITS OWN SECRET, NOT CRON_SECRET ─────────────────────────────────────────────────────────────
 * GitHub Actions and Vercel's cron are different trust contexts. Sharing one secret means a leaked
 * CI variable can also drive every cron route, and a rotated cron secret silently breaks the
 * backup report. BACKUP_RUN_TOKEN is separate for that reason, and the route FAILS CLOSED when it
 * is unset — an unauthenticated writer of backup evidence is worse than no evidence, because the
 * screen would then be reassuring on somebody else's say-so.
 *
 * ── IDEMPOTENT ON THE STAMP ─────────────────────────────────────────────────────────────────────
 * A retried workflow step reports the same night. Upserting on `stamp` makes the second call
 * correct the first rather than inventing a second night, which matters because the health verdict
 * counts consecutive failures: a retry recorded twice would read as two bad nights.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { submissionRefusal, type Submission } from '@/lib/backup-runs';

/** Equal-length timing-safe compare. A plain === leaks the token a byte at a time. */
function sameSecret(given: string, expected: string): boolean {
  // Uint8Array views, as lib/svix-verify does: the Buffer overload is not assignable under this
  // TypeScript's lib.dom types.
  const a = new Uint8Array(Buffer.from(given, 'utf8'));
  const b = new Uint8Array(Buffer.from(expected, 'utf8'));
  if (a.length !== b.length) return false;          // length is not secret; unequal lengths throw
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only.' });

  const expected = process.env.BACKUP_RUN_TOKEN;
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  // FAIL CLOSED. No token configured means nobody may report, not that everybody may.
  if (!expected || !given || !sameSecret(given, expected)) return res.status(401).json({ message: 'Unauthorized.' });

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}) as Partial<Submission>;
  const refusal = submissionRefusal(body);
  if (refusal) return res.status(400).json({ message: refusal });

  const s = body as Submission;
  const data = {
    started_at: new Date(s.startedAt),
    finished_at: s.finishedAt ? new Date(s.finishedAt) : null,
    outcome: s.outcome,
    failed_step: s.failedStep?.trim() || null,
    object_key: s.objectKey?.trim() || null,
    bytes: s.bytes == null ? null : BigInt(s.bytes),
    sha256: s.sha256 || null,
    database_name: s.databaseName || null,
    table_count: s.tableCount ?? null,
    total_rows: s.totalRows ?? null,
    migrations: s.migrations ?? null,
    pg_version: s.pgVersion || null,
    golden_json: (s.golden ?? null) as never,
  };

  try {
    const row = await prisma.backupRun.upsert({
      where: { stamp: s.stamp },
      create: { stamp: s.stamp, ...data },
      update: data,
    });
    return res.status(200).json({ stamp: row.stamp, outcome: row.outcome, recorded: true });
  } catch (e) {
    console.error('backup-run record error:', e);
    return res.status(500).json({ message: 'Could not record the backup run.' });
  }
}
