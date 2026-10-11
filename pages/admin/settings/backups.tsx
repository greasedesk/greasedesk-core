/**
 * File: pages/admin/settings/backups.tsx
 * Settings → Account → Backup & Restore.
 *
 * ── TWO SECTIONS, AND THE SECOND ONE IS NOT THEIRS ──────────────────────────────────────────────
 * The nightly dump is the WHOLE database, every tenant in one encrypted file. Showing that to a
 * garage as "your backup" would be false, and worse, reassuring: they would believe they could be
 * restored on their own. So the platform section states what it is, carries no restore button, and
 * the per-tenant half says plainly that it is not built yet rather than offering a control that
 * half works.
 *
 * ── THE VERDICT IS COMPUTED, NOT LEFT TO THE READER ─────────────────────────────────────────────
 * Eleven nights failed in September. A log of twenty rows where the last nineteen failed looks, at
 * a glance, exactly like a log of twenty where they succeeded — both are a list of dates. The
 * sentence at the top is the whole point of the screen; the table is evidence for it.
 *
 * Rows are read server-side and shaped here: the health verdict comes from lib/backup-runs so this
 * page and anything else that asks cannot disagree about whether backups are working.
 */
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { backupHealth, healthSentence, isBad, VERIFIED_MEANS, type Health } from '@/lib/backup-runs';

type Row = {
  stamp: string; startedAt: string; finishedAt: string | null; outcome: string;
  failedStep: string | null; bytes: string | null; tableCount: number | null; totalRows: number | null;
};
type Props = { rows: Row[]; health: Health; verifiedMeans: string };

const megabytes = (b: string | null) => (b === null ? '—' : `${(Number(b) / 1_048_576).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function BackupsPage({ rows, health, verifiedMeans }: Props) {
  const bad = isBad(health);
  return (
    <SettingsLayout isAdmin>
        <div className="space-y-8 max-w-4xl">

          {/* ── PLATFORM BACKUPS. Factual, and no restore button. ───────────────────────────── */}
          <section data-testid="platform-backups">
            <h2 className="text-lg font-semibold text-fg">Platform backups covering your data</h2>
            <p className="mt-1 text-sm text-muted">
              GreaseDesk backs up its whole database every night, encrypted, to storage separate from the
              database itself. Your records are in every one of those backups. Because each file covers
              every garage on GreaseDesk, it is not a file you can download or restore yourself — see
              below for what you can do.
            </p>

            <div
              data-testid="backup-health"
              data-state={health.state}
              className={`mt-4 rounded-lg border p-4 ${bad ? 'border-danger bg-danger-subtle' : 'border-default bg-subtle'}`}
            >
              <p className={`text-sm font-semibold ${bad ? 'text-danger-strong' : 'text-fg'}`}>
                {healthSentence(health)}
              </p>
              {bad && (
                <p className="mt-2 text-sm text-fg">
                  This is on us to fix, not you. If it is still saying this tomorrow, tell us.
                </p>
              )}
            </div>

            <p className="mt-3 text-xs text-muted" data-testid="verified-means">
              <span className="font-medium text-fg">What “verified” means here: </span>{verifiedMeans}
            </p>

            {rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted" data-testid="no-runs">No backup has reported in yet.</p>
            ) : (
              <table className="mt-4 w-full text-sm" data-testid="runs-table">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th className="py-2 pr-4 font-medium">Night</th>
                    <th className="py-2 pr-4 font-medium">Result</th>
                    <th className="py-2 pr-4 font-medium">Size</th>
                    <th className="py-2 pr-4 font-medium">Contents</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.stamp} className="border-t border-default" data-testid="run-row" data-outcome={r.outcome}>
                      <td className="py-2 pr-4 whitespace-nowrap text-fg">{when(r.startedAt)}</td>
                      <td className="py-2 pr-4">
                        {r.outcome === 'verified'
                          ? <span className="text-success-strong font-medium">Verified</span>
                          : <span className="text-danger-strong font-medium">Failed{r.failedStep ? ` — ${r.failedStep}` : ''}</span>}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-muted">{megabytes(r.bytes)}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-muted">
                        {r.tableCount === null ? '—' : `${r.tableCount} tables, ${(r.totalRows ?? 0).toLocaleString('en-GB')} rows`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── YOUR OWN COPY. Not built; say so rather than offer a control that half works. ── */}
          <section data-testid="your-exports" className="border-t border-default pt-8">
            <h2 className="text-lg font-semibold text-fg">Your own copy of your data</h2>
            <p className="mt-1 text-sm text-muted">
              A download of your garage’s records — customers, vehicles, job cards, invoices, stock and
              the photos attached to them — is not available yet. It is being built. When it is here it
              will appear on this page, and asking for it will not require anybody’s permission.
            </p>
            <p className="mt-3 text-sm text-muted">
              If you need your data before then, <Link href="/admin/support" className="underline font-medium">contact us</Link> and
              we will produce it for you. Your records are yours and we will not make that difficult.
            </p>
          </section>

          {/* ── RESTORE. A request, with a person at the end of it. ──────────────────────────── */}
          <section data-testid="restore" className="border-t border-default pt-8">
            <h2 className="text-lg font-semibold text-fg">Restoring your data</h2>
            <p className="mt-1 text-sm text-muted">
              Putting data back is not a button, and we would rather say so than give you one that only
              half works. Your records live in the same database as every other garage’s, so a restore
              has to be done by hand, by us, with you — deciding what goes back, what stays, and what
              happens to invoice numbers that have already been issued.
            </p>
            <p className="mt-3 text-sm text-muted">
              If something has been deleted or has gone wrong, <Link href="/admin/support" className="underline font-medium">tell us straight away</Link>.
              The sooner you do, the more of it we can recover.
            </p>
          </section>
        </div>
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const guard = await requireAdminPage(ctx);
  if (!guard.ok) return { redirect: guard.redirect };

  // No group_id: a BackupRun is whole-database by construction (lib/tenant-manifest). The LIMIT is
  // what the screen shows, not what the verdict reads — the health is computed from these rows, so
  // taking too few would make a long outage look like a short one.
  const runs = await prisma.backupRun.findMany({
    orderBy: { started_at: 'desc' },
    take: 60,
    select: {
      stamp: true, started_at: true, finished_at: true, outcome: true, failed_step: true,
      bytes: true, table_count: true, total_rows: true,
    },
  });

  const health = backupHealth(runs, new Date());
  const rows: Row[] = runs.map((r) => ({
    stamp: r.stamp,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    outcome: r.outcome,
    failedStep: r.failed_step,
    bytes: r.bytes === null ? null : String(r.bytes),
    tableCount: r.table_count,
    totalRows: r.total_rows,
  }));

  return { props: { rows, health: JSON.parse(JSON.stringify(health)), verifiedMeans: VERIFIED_MEANS } };
};
