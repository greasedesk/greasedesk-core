/**
 * File: pages/rep/index.tsx
 * THE REP'S OWN VIEW: their closed runs, and what is still owed to them.
 *
 * ── SHAPED SERVER-SIDE, AND THE OMISSION IS THE MECHANISM ───────────────────────────────────────
 * CommissionEntry carries held_reason, release_override_reason and shown_as_visited — the area
 * manager's private assessment OF THIS REP. None of the three is in the select below, so none is in
 * the props, so no component can render one by accident and no future edit can uncover one. The
 * same discipline as unit_cost never leaving lib/invoice-doc. rep-invoice-gate scans this file for
 * all three by name.
 *
 * ── HONEST NULL ─────────────────────────────────────────────────────────────────────────────────
 * A rep with no closed runs sees a sentence saying so, not an empty table that reads as £0.00. A
 * run with nothing released to them is not listed at all: they are not owed nothing, they are not
 * owed anything from it, and a row of dashes invites the question every month.
 */
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireRepPage } from '@/lib/rep-auth';
import { missingProfileFields } from '@/lib/rep-invoice';
import { formatMoney } from '@/lib/format-money';

type Run = { id: string; period: string; closedOn: string; linePennies: number; currency: string; invoice: { id: string; number: string; status: string } | null };
type Props = { name: string; runs: Run[]; profileMissing: string[] };

const STATUS_WORDS: Record<string, string> = {
  pending_review: 'Submitted — awaiting review',
  approved: 'Approved for payment',
  paid: 'Paid',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export default function RepHome({ name, runs, profileMissing }: Props) {
  return (
    <>
      <Head><title>Rep portal</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen bg-emerald-950 text-white p-6">
        <h1 className="text-lg font-semibold" data-testid="rep-home">Sales Commission</h1>
        <p className="text-sm text-emerald-200 mt-1">{name}</p>

        {profileMissing.length > 0 && (
          <div className="mt-6 rounded-xl bg-amber-100 text-amber-900 p-4 text-sm" data-testid="rep-profile-incomplete">
            Before you can raise your first invoice we need a few details.{' '}
            <Link href="/rep/profile" className="underline font-medium">Complete your profile</Link>
          </div>
        )}

        <h2 className="text-sm uppercase tracking-wide text-emerald-400 mt-8 mb-2">Closed runs</h2>
        {runs.length === 0 ? (
          // NOT AN EMPTY TABLE. "No closed runs yet" is a different fact from "£0.00", and only one
          // of them is true here.
          <p className="text-sm text-emerald-200" data-testid="rep-no-runs">
            No closed runs yet. A run appears here once it has been signed off.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="rep-runs">
            {runs.map((r) => (
              <li key={r.id} className="rounded-xl bg-emerald-900 p-4 flex items-center justify-between">
                <div>
                  <div className="font-medium">{r.period}</div>
                  <div className="text-xs text-emerald-300">Closed {r.closedOn}</div>
                  {r.invoice && (
                    <div className="text-xs text-emerald-300 mt-1" data-testid="rep-run-invoice">
                      Invoice {r.invoice.number} — {STATUS_WORDS[r.invoice.status] ?? r.invoice.status}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="font-semibold">{formatMoney(r.linePennies, { currency: r.currency })}</div>
                  {!r.invoice && (
                    <Link href={`/rep/runs/${r.id}`} className="text-xs underline text-emerald-200" data-testid="rep-run-open">
                      Raise your invoice
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireRepPage(ctx);
  if (!gate.ok) return { notFound: true };

  const rep = await prisma.rep.findUnique({ where: { id: gate.rep.repId } });
  if (!rep) return { notFound: true };

  // ONLY WHAT THIS REP MAY SEE. No held_reason, no release_override_reason, no shown_as_visited.
  const entries = await prisma.commissionEntry.findMany({
    where: { party_id: rep.id, status: { in: ['released', 'billed', 'paid'] }, pay_run: { status: 'closed' } },
    select: { period: true, amount_pennies: true, currency: true, status: true, pay_run_id: true, rep_invoice_id: true },
  });
  const runIds = [...new Set(entries.map((e) => e.pay_run_id).filter(Boolean) as string[])];
  const runRows = await prisma.repPayRun.findMany({ where: { id: { in: runIds } }, orderBy: { period: 'desc' }, select: { id: true, period: true, closed_at: true } });
  const invoices = await prisma.repInvoice.findMany({ where: { rep_id: rep.id }, select: { id: true, pay_run_id: true, rep_invoice_number: true, status: true } });

  const runs: Run[] = runRows.map((r) => {
    const mine = entries.filter((e) => e.pay_run_id === r.id);
    const inv = invoices.find((i) => i.pay_run_id === r.id) ?? null;
    return {
      id: r.id,
      period: r.period,
      closedOn: r.closed_at ? r.closed_at.toISOString().slice(0, 10) : '',
      linePennies: mine.reduce((a, e) => a + e.amount_pennies, 0),
      currency: mine[0]?.currency ?? 'GBP',
      invoice: inv ? { id: inv.id, number: inv.rep_invoice_number, status: inv.status } : null,
    };
  });

  return { props: { name: rep.name, runs, profileMissing: missingProfileFields(rep) } };
};
