/**
 * File: pages/admin/settings/profile.tsx
 * Settings → Profile. Change your own password (any user); view company details (everyone),
 * editable only by ADMIN/owner (server-gated via /api/company).
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { getVisibility } from '@/lib/site-visibility';

type Company = { group_name: string; company_number: string | null; vat_number: string | null };
type Account = { ref: string; status: string; trialEndsAt: string | null };
type PageProps = { email: string; company: Company; account: Account; isAdmin: boolean };

function AccountRef({ account }: { account: Account }) {
  const ends = account.trialEndsAt ? new Date(account.trialEndsAt).toLocaleDateString('en-GB') : '—';
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md mb-6">
      <h2 className="text-lg font-semibold text-white mb-4">Account</h2>
      <div className="space-y-2 text-sm">
        <div><span className="text-slate-400">Reference: </span><span className="text-slate-100 font-mono">{account.ref}</span> <span className="text-slate-500 text-xs">(permanent)</span></div>
        <div><span className="text-slate-400">Status: </span><span className="text-slate-100 capitalize">{account.status}</span></div>
        <div><span className="text-slate-400">Trial ends: </span><span className="text-slate-100">{ends}</span></div>
      </div>
    </div>
  );
}

const inputClass = 'w-full p-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:ring-blue-500 focus:border-blue-500';
const labelClass = 'block text-xs text-slate-400 mb-1';

async function post(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch {
    return 'Network error.';
  }
}

function ChangePassword() {
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const err = await post('/api/account/change-password', 'POST', { currentPassword: cur, newPassword: nw, confirmPassword: cf });
    setBusy(false);
    if (err) return setMsg({ text: err, type: 'error' });
    setCur(''); setNw(''); setCf('');
    setMsg({ text: 'Password changed.', type: 'success' });
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md mb-6">
      <h2 className="text-lg font-semibold text-white mb-4">Change password</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}
      <form onSubmit={submit} className="space-y-3">
        <div><label className={labelClass}>Current password</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>New password (min 8 characters)</label><input type="password" value={nw} onChange={(e) => setNw(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>Confirm new password</label><input type="password" value={cf} onChange={(e) => setCf(e.target.value)} required className={inputClass} /></div>
        <button type="submit" disabled={busy} className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

function CompanyDetails({ company, isAdmin }: { company: Company; isAdmin: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(company.group_name);
  const [num, setNum] = useState(company.company_number ?? '');
  const [vat, setVat] = useState(company.vat_number ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const err = await post('/api/company', 'PATCH', { group_name: name, company_number: num, vat_number: vat });
    setBusy(false);
    if (err) return setMsg({ text: err, type: 'error' });
    setMsg({ text: 'Company details saved.', type: 'success' });
    router.replace(router.asPath);
  }

  if (!isAdmin) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md">
        <h2 className="text-lg font-semibold text-white mb-4">Company</h2>
        <div className="space-y-2 text-sm">
          <div><span className="text-slate-400">Name: </span><span className="text-slate-100">{company.group_name}</span></div>
          <div><span className="text-slate-400">Company number: </span><span className="text-slate-100">{company.company_number || '—'}</span></div>
          <div><span className="text-slate-400">VAT number: </span><span className="text-slate-100">{company.vat_number || '—'}</span></div>
        </div>
        <p className="text-xs text-slate-500 mt-3">Only an admin can edit company details.</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md">
      <h2 className="text-lg font-semibold text-white mb-4">Company details</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}
      <form onSubmit={save} className="space-y-3">
        <div><label className={labelClass}>Company name *</label><input value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>Company number</label><input value={num} onChange={(e) => setNum(e.target.value)} className={inputClass} /></div>
        <div><label className={labelClass}>VAT number</label><input value={vat} onChange={(e) => setVat(e.target.value)} className={inputClass} /></div>
        <button type="submit" disabled={busy} className="bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
          {busy ? 'Saving…' : 'Save company details'}
        </button>
      </form>
    </div>
  );
}

export default function ProfileSettings({ email, company, account, isAdmin }: PageProps) {
  return (
    <SettingsLayout>
      <Head><title>Profile - GreaseDesk</title></Head>
      <p className="text-slate-400 mb-6">Signed in as <strong>{email}</strong> · {company.group_name} ({account.ref})</p>
      <AccountRef account={account} />
      <ChangePassword />
      <CompanyDetails company={company} isAdmin={isAdmin} />
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id || !sUser?.group_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  const [vis, group] = await Promise.all([
    getVisibility(sUser.id as string),
    prisma.group.findUnique({
      where: { id: sUser.group_id },
      select: { group_name: true, company_number: true, vat_number: true, ref: true, status: true, trial_ends_at: true },
    }) as Promise<(Company & { ref: string; status: string; trial_ends_at: Date | null }) | null>,
  ]);

  return {
    props: {
      email: (sUser.email as string) ?? '',
      company: group
        ? { group_name: group.group_name, company_number: group.company_number, vat_number: group.vat_number }
        : { group_name: 'Your company', company_number: null, vat_number: null },
      account: {
        ref: group?.ref ?? '—',
        status: group?.status ?? 'trial',
        trialEndsAt: group?.trial_ends_at ? group.trial_ends_at.toISOString() : null,
      },
      isAdmin: vis.isAdmin,
    },
  };
};
