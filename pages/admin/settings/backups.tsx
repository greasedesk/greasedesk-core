/**
 * File: pages/admin/settings/backups.tsx
 * Settings → Account → Backup & Restore. The GARAGE's view, and only the garage's.
 *
 * ── WHAT THIS PAGE DELIBERATELY DOES NOT SHOW ───────────────────────────────────────────────────
 * It used to show the whole BackupRun table: dump size, table and row counts, the failed step, and
 * the computed health verdict. `BackupRun` has no `group_id` — a backup is the whole database — so
 * those were GREASEDESK's figures, shown to every garage admin behind this tenant guard. For the
 * nineteen nights to 31 Oct 2026 the verdict would have told customers their supplier's backups
 * were failing. No customer data was exposed; our internals were, to an audience that cannot act on
 * them.
 *
 * The operator view moved to /superadmin/backups (owner-only). What stays here is the only thing a
 * garage needs from us: that backups happen nightly, and the date of the last verified one.
 *
 * ── THE DATE, NOT A VERDICT, AND WHY THAT IS STILL HONEST ───────────────────────────────────────
 * Naming the date is not a softer truth than the verdict — it is the same truth in the garage's
 * terms. If backups stop, this page says "the last verified backup was 11 days ago", which is the
 * fact that matters to them, without the platform's row counts or a sentence about our failures
 * they can do nothing with. A reassuring blank would have been the dishonest option; this is not it.
 *
 * ── AND NO RESTORE BUTTON ───────────────────────────────────────────────────────────────────────
 * The per-tenant half says plainly that a download is not built yet rather than offering a control
 * that half works.
 */
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { VERIFIED_MEANS } from '@/lib/backup-runs';

/** The ONE fact this page carries about the platform: when a backup last verified, or never. */
type Props = { lastVerifiedAt: string | null; verifiedMeans: string };

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function BackupsPage({ lastVerifiedAt, verifiedMeans }: Props) {
  return (
    <SettingsLayout isAdmin>
        <div className="space-y-8 max-w-4xl">

          {/* ── PLATFORM BACKUPS. One statement and one date. No figures, no verdict. ───────── */}
          <section data-testid="platform-backups">
            <h2 className="text-lg font-semibold text-fg">Platform backups covering your data</h2>
            <p className="mt-1 text-sm text-muted">
              GreaseDesk backs up its whole database every night, encrypted, to storage separate from the
              database itself. Your records are in every one of those backups. Because each file covers
              every garage on GreaseDesk, it is not a file you can download or restore yourself — see
              below for what you can do.
            </p>

            <div data-testid="last-verified" className="mt-4 rounded-lg border border-default bg-subtle p-4">
              {lastVerifiedAt === null ? (
                <p className="text-sm font-semibold text-fg">
                  No backup has verified yet. If you are seeing this, tell us — we would want to know.
                </p>
              ) : (
                <p className="text-sm font-semibold text-fg">
                  Backups run nightly. The last one verified on {when(lastVerifiedAt)}.
                </p>
              )}
            </div>

            <p className="mt-3 text-xs text-muted" data-testid="verified-means">
              <span className="font-medium text-fg">What “verified” means here: </span>{verifiedMeans}
            </p>
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

  // ONE ROW, ONE COLUMN. Not the table and not the verdict — see the header. Taking only the latest
  // VERIFIED run is also what makes the sentence true: the newest run might be a failure, and "the
  // last one verified" is the date a garage can rely on, not the date something last ran.
  const last = await prisma.backupRun.findFirst({
    where: { outcome: 'verified' },
    orderBy: { started_at: 'desc' },
    select: { started_at: true },
  });

  return { props: { lastVerifiedAt: last?.started_at.toISOString() ?? null, verifiedMeans: VERIFIED_MEANS } };
};
