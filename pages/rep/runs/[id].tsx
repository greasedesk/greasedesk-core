/**
 * File: pages/rep/runs/[id].tsx
 * ONE CLOSED RUN, AND THE INVOICE THE REP RAISES FOR IT.
 *
 * The number box is PREFILLED with their last plus one and is fully editable: it is their series,
 * from their own sales ledger, and our guess at it is a convenience and never a rule. A rep with no
 * previous invoice gets an empty box rather than our invention of how they number things.
 *
 * VAT is stated before submission, not discovered on the PDF. An unregistered rep is told in words
 * that their invoice carries none — that is the refusal being visible rather than the VAT merely
 * being absent, and it is what stops somebody assuming we forgot.
 *
 * Same shaping rule as /rep: held_reason, release_override_reason and shown_as_visited are not in
 * the select, so they are not in the props.
 */
import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireRepPage } from '@/lib/rep-auth';
import { missingProfileFields, nextInvoiceNumber, vatAppliesTo, VAT_RATE_BP } from '@/lib/rep-invoice';
import { invoiceDateFor } from '@/lib/rep-invoice-submit';
import { formatMoney } from '@/lib/format-money';

type Line = { period: string; isArrears: boolean; garage: string; amountPennies: number };
type Props = {
  runId: string; period: string; currency: string; lines: Line[]; subtotalPennies: number;
  vatApplied: boolean; vatPennies: number | null; totalPennies: number;
  suggestedNumber: string | null; profileMissing: string[];
};

export default function RepRun(p: Props) {
  const router = useRouter();
  const [number, setNumber] = useState(p.suggestedNumber ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const money = (x: number) => formatMoney(x, { currency: p.currency });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/rep/invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payRunId: p.runId, number }),
      });
      if (!r.ok) { setErr((await r.json().catch(() => ({}))).message ?? 'That could not be submitted.'); return; }
      await router.push('/rep');
    } finally {
      setBusy(false);   // in finally: a push replaces the route without unmounting this component
    }
  };

  return (
    <>
      <Head><title>Invoice — {p.period}</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen bg-emerald-950 text-white p-6">
        <Link href="/rep" className="text-xs text-emerald-300 underline">← Back</Link>
        <h1 className="text-lg font-semibold mt-2" data-testid="rep-run-heading">Sales Commission — {p.period}</h1>

        <ul className="mt-6 space-y-2" data-testid="rep-run-lines">
          {p.lines.map((l, i) => (
            <li key={i} className="rounded-xl bg-emerald-900 p-3 flex justify-between text-sm">
              <div>
                <div>{l.garage}</div>
                {l.isArrears && <div className="text-xs text-amber-300" data-testid="rep-arrears">Arrears — {l.period}</div>}
              </div>
              <div>{money(l.amountPennies)}</div>
            </li>
          ))}
        </ul>

        <div className="mt-4 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-emerald-300">Subtotal</span><span>{money(p.subtotalPennies)}</span></div>
          {p.vatApplied ? (
            <div className="flex justify-between" data-testid="rep-vat"><span className="text-emerald-300">VAT at {VAT_RATE_BP / 100}%</span><span>{money(p.vatPennies ?? 0)}</span></div>
          ) : (
            // THE REFUSAL, IN WORDS. Not a missing line — a stated one, so nobody reads the absence
            // as an oversight and asks us to "add the VAT back".
            <div className="text-xs text-emerald-300" data-testid="rep-no-vat">
              No VAT — your profile says you are not VAT registered for this period.
            </div>
          )}
          <div className="flex justify-between font-semibold pt-1 border-t border-emerald-800"><span>Total</span><span>{money(p.totalPennies)}</span></div>
        </div>

        {p.profileMissing.length > 0 ? (
          <div className="mt-6 rounded-xl bg-amber-100 text-amber-900 p-4 text-sm" data-testid="rep-blocked">
            Complete your profile before raising an invoice — still needed: {p.profileMissing.join(', ')}.{' '}
            <Link href="/rep/profile" className="underline font-medium">Complete it</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3" data-testid="rep-invoice-form">
            <label className="block text-sm text-emerald-200" htmlFor="rep-number">Your invoice number</label>
            <input id="rep-number" value={number} onChange={(e) => setNumber(e.target.value)} required data-testid="rep-number"
              className="w-full min-h-[48px] rounded-lg px-3 text-slate-900" />
            <p className="text-xs text-emerald-400">From your own series — change it to whatever your books say.</p>
            {err && <p className="text-sm text-red-300" data-testid="rep-invoice-error">{err}</p>}
            <button type="submit" disabled={busy} data-testid="rep-submit"
              className="w-full min-h-[48px] bg-emerald-600 rounded-lg font-medium disabled:opacity-60">
              {busy ? 'Submitting…' : 'Submit invoice'}
            </button>
          </form>
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

  const run = await prisma.repPayRun.findFirst({ where: { id: String(ctx.params?.id ?? ''), status: 'closed' } });
  if (!run || !run.closed_at) return { notFound: true };

  // NO PRIVATE COLUMNS. See the header.
  const entries = await prisma.commissionEntry.findMany({
    where: { pay_run_id: run.id, party_id: rep.id, status: 'released', rep_invoice_id: null },
    orderBy: { period: 'asc' },
    select: { group_id: true, period: true, amount_pennies: true, currency: true },
  });
  if (entries.length === 0) return { notFound: true };   // nothing to invoice is not an empty form

  const groups = await prisma.group.findMany({ where: { id: { in: entries.map((e) => e.group_id) } }, select: { id: true, group_name: true } });
  const lines: Line[] = entries.map((e) => ({
    period: e.period,
    isArrears: e.period < run.period,
    garage: groups.find((g) => g.id === e.group_id)?.group_name ?? 'Unknown garage',
    amountPennies: e.amount_pennies,
  }));

  const subtotalPennies = lines.reduce((a, l) => a + l.amountPennies, 0);
  // THE SAME DATE THE SUBMISSION WILL USE, so the VAT shown here is the VAT that lands on the PDF.
  const invoiceDate = invoiceDateFor(run.closed_at);
  const vatApplied = vatAppliesTo(rep, invoiceDate);
  const vatPennies = vatApplied ? Math.round((subtotalPennies * VAT_RATE_BP) / 10000) : null;

  const last = await prisma.repInvoice.findFirst({
    where: { rep_id: rep.id }, orderBy: { submitted_at: 'desc' }, select: { rep_invoice_number: true },
  });

  return {
    props: {
      runId: run.id, period: run.period, currency: entries[0].currency, lines, subtotalPennies,
      vatApplied, vatPennies, totalPennies: subtotalPennies + (vatPennies ?? 0),
      suggestedNumber: nextInvoiceNumber(last?.rep_invoice_number ?? null),
      profileMissing: missingProfileFields(rep),
    },
  };
};
