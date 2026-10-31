/**
 * File: pages/superadmin/backups.tsx
 * Engine Room — the nightly backup record. OWNER-only (nav minRole owner; this gssp independently
 * enforces the same, like setup-steps).
 *
 * ── WHY THIS PAGE EXISTS SEPARATELY FROM THE TENANT ONE ─────────────────────────────────────────
 * `/admin/settings/backups` was the only backup screen, and it sits behind the TENANT admin guard.
 * `BackupRun` has no `group_id` by construction — a backup is the whole database — so every garage
 * admin was reading GreaseDesk's own figures: the dump size, the table and row counts across all
 * tenants, the failed step, and the health verdict. For the nineteen nights to 31 Oct 2026 that
 * verdict would have told customers their supplier's backups were failing.
 *
 * No customer's data was exposed. What was exposed was our internals, to an audience that cannot act
 * on them and should not have to read them. So the split is by AUDIENCE, not by permission level:
 *   • the garage is told backups run nightly and when the last one verified — their own assurance;
 *   • everything an operator needs to diagnose a bad night is here.
 *
 * ── THE VERDICT IS COMPUTED, NOT LEFT TO THE READER ─────────────────────────────────────────────
 * Unchanged from the tenant page, and the reason is unchanged: a log of twenty rows where the last
 * nineteen failed looks exactly like a log of twenty that succeeded. `backupHealth` names the
 * number. Both screens read it from lib/backup-runs so they cannot disagree about whether backups
 * are working.
 */
import React from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import { requireOperatorPage, roleAtLeast, type OperatorRoleName } from '@/lib/operator-auth';
import { backupHealth, healthSentence, isBad, VERIFIED_MEANS, type Health } from '@/lib/backup-runs';

type Row = {
  stamp: string; startedAt: string; finishedAt: string | null; outcome: string;
  failedStep: string | null; objectKey: string | null; bytes: string | null; sha256: string | null;
  databaseName: string | null; tableCount: number | null; totalRows: number | null;
  migrations: number | null; pgVersion: string | null;
};
type PageProps = { rows: Row[]; health: Health; verifiedMeans: string; role: OperatorRoleName };

const megabytes = (b: string | null) => (b === null ? '—' : `${(Number(b) / 1_048_576).toFixed(1)} MB`);
const when = (iso: string | null) =>
  iso === null ? '—' : new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Minutes, because a backup that suddenly takes three times as long is worth noticing. */
const took = (a: string, b: string | null) =>
  b === null ? '—' : `${Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000))}s`;

export default function EngineRoomBackups({ rows, health, verifiedMeans, role }: PageProps) {
  const bad = isBad(health);
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — backups</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-6xl">
        <div className="flex items-baseline justify-between mb-5">
          <h1 className="text-xl font-semibold">Backups</h1>
          <span className="text-xs text-muted">nightly, whole database · owner only</span>
        </div>

        <div
          data-testid="er-backup-health"
          data-state={health.state}
          className={`rounded-xl border p-5 ${bad ? 'border-danger bg-danger-subtle' : 'border-line bg-surface'}`}
        >
          <p className={`text-sm font-semibold ${bad ? 'text-danger-strong' : 'text-ink'}`}>{healthSentence(health)}</p>
          <p className="mt-2 text-xs text-muted">
            <span className="font-medium text-ink">What “verified” means: </span>{verifiedMeans}
          </p>
        </div>

        {rows.length === 0 ? (
          <p className="mt-5 text-sm text-muted" data-testid="er-no-runs">
            No backup has reported in yet. The job can be running and verifying nightly while reporting
            nothing — that is exactly what happened for nineteen nights — so an empty table here means
            either no backup or no report, and those need different actions.
          </p>
        ) : (
          <table className="mt-5 w-full text-sm" data-testid="er-runs-table">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-4 font-medium">Started</th>
                <th className="py-2 pr-4 font-medium">Took</th>
                <th className="py-2 pr-4 font-medium">Result</th>
                <th className="py-2 pr-4 font-medium">Size</th>
                <th className="py-2 pr-4 font-medium">Contents</th>
                <th className="py-2 pr-4 font-medium">Postgres</th>
                <th className="py-2 pr-4 font-medium">Object</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.stamp} className="border-t border-line" data-testid="er-run-row" data-outcome={r.outcome}>
                  <td className="py-2 pr-4 whitespace-nowrap text-ink">{when(r.startedAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-muted tabular-nums">{took(r.startedAt, r.finishedAt)}</td>
                  <td className="py-2 pr-4">
                    {r.outcome === 'verified'
                      ? <span className="text-success-strong font-medium">Verified</span>
                      : <span className="text-danger-strong font-medium">Failed{r.failedStep ? ` — ${r.failedStep}` : ''}</span>}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-muted tabular-nums">{megabytes(r.bytes)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-muted">
                    {r.tableCount === null ? '—' : `${r.tableCount} tables, ${(r.totalRows ?? 0).toLocaleString('en-GB')} rows`}
                    {r.migrations === null ? '' : ` · ${r.migrations} migrations`}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-muted">{r.pgVersion ?? '—'}</td>
                  {/* The object key is how you fetch the file in a real restore, so it is shown in
                      full rather than truncated — docs/RESTORE.md takes it verbatim. */}
                  <td className="py-2 pr-4 text-xs text-muted break-all">{r.objectKey ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-5 text-xs text-muted">
          Restoring for real: <code>docs/RESTORE.md</code>. The garage-facing version of this page is
          Settings → Backup &amp; Restore, and it deliberately shows none of the figures above.
        </p>
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx);
  if (!gate.ok) return { notFound: true };
  if (!roleAtLeast(gate.op.role, 'owner')) return { notFound: true }; // owner-only screen, undiscoverable below

  // NOT region-scoped, and there is nothing to scope: a BackupRun has no group_id because a backup is
  // the whole database. That is also why the screen is owner-only rather than region-managed.
  //
  // The LIMIT is what the table shows, not what the verdict reads — `backupHealth` counts from these
  // rows, so taking too few would make a long outage look like a short one.
  const runs = await prisma.backupRun.findMany({
    orderBy: { started_at: 'desc' },
    take: 90,
    select: {
      stamp: true, started_at: true, finished_at: true, outcome: true, failed_step: true,
      object_key: true, bytes: true, sha256: true, database_name: true,
      table_count: true, total_rows: true, migrations: true, pg_version: true,
    },
  });

  const health = backupHealth(runs, new Date());
  const rows: Row[] = runs.map((r) => ({
    stamp: r.stamp,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    outcome: r.outcome,
    failedStep: r.failed_step,
    objectKey: r.object_key,
    bytes: r.bytes === null ? null : String(r.bytes),
    sha256: r.sha256,
    databaseName: r.database_name,
    tableCount: r.table_count,
    totalRows: r.total_rows,
    migrations: r.migrations,
    pgVersion: r.pg_version,
  }));

  return { props: { rows, health: JSON.parse(JSON.stringify(health)), verifiedMeans: VERIFIED_MEANS, role: gate.op.role } };
};
