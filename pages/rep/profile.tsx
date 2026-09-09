/**
 * File: pages/rep/profile.tsx
 * THE PROFILE A REP FILLS IN ONCE, before their first invoice.
 *
 * ── TWO FIELDS ARE NOT HERE, AND THAT IS THE POINT ──────────────────────────────────────────────
 * The sign-in EMAIL and the BANK DETAILS. Both are operator-only and both changes are audited. The
 * email is the whole credential now that passwords are gone; the bank details are where our money
 * goes. They are shown READ-ONLY so a rep can check them and ask, which is a different thing from
 * being unable to see what we hold about them.
 *
 * ── THE UTR IS OPTIONAL AND SAYS SO ─────────────────────────────────────────────────────────────
 * It is not an invoice requirement. A form that marked it required would strand a rep who cannot
 * find the letter, over a rule HMRC does not have.
 */
import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireRepPage } from '@/lib/rep-auth';
import { missingProfileFields } from '@/lib/rep-invoice';

type Props = {
  rep: {
    trading_name: string | null; address_line1: string | null; address_line2: string | null;
    address_locality: string | null; address_region: string | null; address_postcode: string | null;
    contact_email: string | null; utr: string | null;
    vat_registered: boolean | null; vat_number: string | null; vat_effective_from: string | null;
  };
  loginEmail: string;
  /** NULL = we hold no bank details. Rendered as missing, never as an empty field. */
  bank: { accountName: string; sortCode: string; accountNumber: string } | null;
  missing: string[];
};

export default function RepProfile({ rep, loginEmail, bank }: Props) {
  const router = useRouter();
  const [f, setF] = useState(rep);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof Props['rep']) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/rep/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      if (!r.ok) { setErr((await r.json().catch(() => ({}))).message ?? 'That could not be saved.'); return; }
      await router.push('/rep');
    } finally {
      setBusy(false);
    }
  };

  const Field = ({ k, label, required = false, type = 'text' }: { k: keyof Props['rep']; label: string; required?: boolean; type?: string }) => (
    <div>
      <label className="block text-sm text-emerald-200 mb-1" htmlFor={`f-${k}`}>{label}{required ? '' : ' (optional)'}</label>
      <input id={`f-${k}`} type={type} value={String(f[k] ?? '')} onChange={set(k)} required={required} data-testid={`rep-${k}`}
        className="w-full min-h-[48px] rounded-lg px-3 text-slate-900" />
    </div>
  );

  return (
    <>
      <Head><title>Your details</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen bg-emerald-950 text-white p-6">
        <Link href="/rep" className="text-xs text-emerald-300 underline">← Back</Link>
        <h1 className="text-lg font-semibold mt-2" data-testid="rep-profile">Your details</h1>
        <p className="text-sm text-emerald-300 mt-1">These appear on the invoices you raise to GreaseDesk.</p>

        <form onSubmit={save} className="mt-6 space-y-4">
          <Field k="trading_name" label="Legal trading name" required />
          <Field k="address_line1" label="Address" required />
          <Field k="address_line2" label="Address line 2" />
          <Field k="address_locality" label="Town or city" />
          <Field k="address_region" label="County" />
          <Field k="address_postcode" label="Postcode" required />
          <Field k="contact_email" label="Contact email for your invoices" required />

          <fieldset className="border border-emerald-800 rounded-lg p-3">
            <legend className="text-sm px-1">VAT</legend>
            {/* THREE-STATE, ON PURPOSE. Unanswered is not "no": until one of these is chosen the
                profile is incomplete and the first invoice is refused. */}
            <div className="flex gap-4 text-sm">
              {[['Registered', true], ['Not registered', false]].map(([label, v]) => (
                <label key={String(v)} className="flex items-center gap-2">
                  <input type="radio" name="vat" checked={f.vat_registered === v} data-testid={`rep-vat-${v}`}
                    onChange={() => setF({ ...f, vat_registered: v as boolean })} />
                  {label}
                </label>
              ))}
            </div>
            {f.vat_registered === true && (
              <div className="mt-3 space-y-3">
                <Field k="vat_number" label="VAT number" required />
                <Field k="vat_effective_from" label="Registered from" required type="date" />
                <p className="text-xs text-emerald-400">
                  Invoices dated before this carry no VAT — that is what keeps your earlier months right.
                </p>
              </div>
            )}
          </fieldset>

          <Field k="utr" label="UTR" />
          <p className="text-xs text-emerald-400 -mt-2" data-testid="rep-utr-optional">
            Not needed to raise an invoice. We hold it if you give it.
          </p>

          {err && <p className="text-sm text-red-300" data-testid="rep-profile-error">{err}</p>}
          <button type="submit" disabled={busy} data-testid="rep-profile-save"
            className="w-full min-h-[48px] bg-emerald-600 rounded-lg font-medium disabled:opacity-60">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>

        <div className="mt-8 border-t border-emerald-800 pt-4 text-sm" data-testid="rep-readonly">
          <h2 className="text-xs uppercase tracking-wide text-emerald-400 mb-2">Held by GreaseDesk</h2>
          <p className="text-emerald-200">Sign-in email: {loginEmail}</p>
          <p className="text-emerald-200 mt-1">
            {bank
              ? `Paid to ${bank.accountName} · ${bank.sortCode} · ${bank.accountNumber}`
              : 'No bank details recorded.'}
          </p>
          <p className="text-xs text-emerald-500 mt-2">
            Changing either is done by your area manager — ask them, and the change is recorded.
          </p>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireRepPage(ctx);
  if (!gate.ok) return gate.result;   // redirect to sign-in, or 404 for a wrong actor class
  const r = await prisma.rep.findUnique({ where: { id: gate.rep.repId } });
  if (!r) return { notFound: true };

  return {
    props: {
      rep: {
        trading_name: r.trading_name, address_line1: r.address_line1, address_line2: r.address_line2,
        address_locality: r.address_locality, address_region: r.address_region, address_postcode: r.address_postcode,
        contact_email: r.contact_email, utr: r.utr,
        vat_registered: r.vat_registered,
        vat_number: r.vat_number,
        vat_effective_from: r.vat_effective_from ? r.vat_effective_from.toISOString().slice(0, 10) : null,
      },
      loginEmail: r.email,
      // ALL THREE OR NONE — Rep_bank_chk. A partial block would read as filled in.
      bank: r.bank_account_name && r.bank_sort_code && r.bank_account_number
        ? { accountName: r.bank_account_name, sortCode: r.bank_sort_code, accountNumber: r.bank_account_number }
        : null,
      missing: missingProfileFields(r),
    },
  };
};
