/**
 * File: pages/admin/settings/profile.tsx
 * Tabbed profile. A user edits their OWN profile; an ADMIN can edit any user in their group
 * via ?user=<id> (group-scoped). emergency_note shows only to the owner or an admin.
 * On the self view, the account/company/change-password sections (prior slice) remain.
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
type Profile = {
  id: string; name: string; email: string; job_title: string; start_date: string;
  phone: string; address: string; driving_licence_categories: string;
  next_of_kin_name: string; next_of_kin_relationship: string; next_of_kin_phone: string;
  certifications: string; working_hours: string;
  emergency_note?: string; // present only when the viewer may see it
};
type PageProps = {
  email: string;
  isSelf: boolean;
  canSeeEmergency: boolean;
  isAdmin: boolean;
  isManager: boolean;
  profile: Profile;
  company: Company | null; // self view only
  account: Account | null; // self view only
};

const inputClass = 'w-full p-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:ring-blue-500 focus:border-blue-500';
const labelClass = 'block text-xs text-slate-400 mb-1';

async function post(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch { return 'Network error.'; }
}

// ---- existing sections (self view only) ----
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

function ChangePassword() {
  const [cur, setCur] = useState(''); const [nw, setNw] = useState(''); const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const err = await post('/api/account/change-password', 'POST', { currentPassword: cur, newPassword: nw, confirmPassword: cf });
    setBusy(false);
    if (err) return setMsg({ text: err, type: 'error' });
    setCur(''); setNw(''); setCf(''); setMsg({ text: 'Password changed.', type: 'success' });
  }
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md mb-6">
      <h2 className="text-lg font-semibold text-white mb-4">Change password</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}
      <form onSubmit={submit} className="space-y-3">
        <div><label className={labelClass}>Current password</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>New password (min 8 characters)</label><input type="password" value={nw} onChange={(e) => setNw(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>Confirm new password</label><input type="password" value={cf} onChange={(e) => setCf(e.target.value)} required className={inputClass} /></div>
        <button type="submit" disabled={busy} className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Change password'}</button>
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
    e.preventDefault(); setBusy(true); setMsg(null);
    const err = await post('/api/company', 'PATCH', { group_name: name, company_number: num, vat_number: vat });
    setBusy(false);
    if (err) return setMsg({ text: err, type: 'error' });
    setMsg({ text: 'Company details saved.', type: 'success' }); router.replace(router.asPath);
  }
  if (!isAdmin) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md mb-6">
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
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md mb-6">
      <h2 className="text-lg font-semibold text-white mb-4">Company details</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}
      <form onSubmit={save} className="space-y-3">
        <div><label className={labelClass}>Company name *</label><input value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>Company number</label><input value={num} onChange={(e) => setNum(e.target.value)} className={inputClass} /></div>
        <div><label className={labelClass}>VAT number</label><input value={vat} onChange={(e) => setVat(e.target.value)} className={inputClass} /></div>
        <button type="submit" disabled={busy} className="bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save company details'}</button>
      </form>
    </div>
  );
}

// ---- tabbed personal profile ----
const TABS = ['Overview', 'Personal & Safety', 'Professional', 'Leave & Absence'] as const;
type Tab = typeof TABS[number];

function ProfileTabs({ profile, isSelf, canSeeEmergency }: { profile: Profile; isSelf: boolean; canSeeEmergency: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('Overview');
  const [f, setF] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true); setMsg(null);
    const payload: any = {
      name: f.name, job_title: f.job_title, start_date: f.start_date || null, phone: f.phone, address: f.address,
      driving_licence_categories: f.driving_licence_categories,
      next_of_kin_name: f.next_of_kin_name, next_of_kin_relationship: f.next_of_kin_relationship, next_of_kin_phone: f.next_of_kin_phone,
      certifications: f.certifications, working_hours: f.working_hours,
    };
    if (canSeeEmergency) payload.emergency_note = f.emergency_note ?? '';
    if (!isSelf) payload.userId = profile.id;
    const err = await post('/api/profile', 'PATCH', payload);
    setBusy(false);
    if (err) return setMsg({ text: err, type: 'error' });
    setMsg({ text: 'Profile saved.', type: 'success' });
    router.replace(router.asPath);
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-2xl">
      <div className="flex flex-wrap gap-1 border-b border-slate-700 mb-5">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm rounded-t-lg ${tab === t ? 'bg-slate-700 text-white border-b-2 border-blue-500 font-semibold' : 'text-slate-400 hover:text-white'}`}>{t}</button>
        ))}
      </div>
      {msg && <div className={`p-2 rounded mb-4 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}

      {tab === 'Overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label className={labelClass}>Full name</label><input value={f.name} onChange={set('name')} className={inputClass} /></div>
          <div><label className={labelClass}>Job title</label><input value={f.job_title} onChange={set('job_title')} className={inputClass} /></div>
          <div><label className={labelClass}>Start date</label><input type="date" value={f.start_date} onChange={set('start_date')} className={inputClass} /></div>
          <div><label className={labelClass}>Phone</label><input value={f.phone} onChange={set('phone')} className={inputClass} /></div>
          <div><label className={labelClass}>Email (login — read-only)</label><input value={f.email} readOnly className={`${inputClass} opacity-60 cursor-not-allowed`} /></div>
          <div><label className={labelClass}>Driving licence categories</label><input value={f.driving_licence_categories} onChange={set('driving_licence_categories')} className={inputClass} /></div>
          <div className="sm:col-span-2"><label className={labelClass}>Address</label><input value={f.address} onChange={set('address')} className={inputClass} /></div>
        </div>
      )}

      {tab === 'Personal & Safety' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label className={labelClass}>Next of kin — name</label><input value={f.next_of_kin_name} onChange={set('next_of_kin_name')} className={inputClass} /></div>
          <div><label className={labelClass}>Next of kin — relationship</label><input value={f.next_of_kin_relationship} onChange={set('next_of_kin_relationship')} className={inputClass} /></div>
          <div><label className={labelClass}>Next of kin — phone</label><input value={f.next_of_kin_phone} onChange={set('next_of_kin_phone')} className={inputClass} /></div>
          {canSeeEmergency && (
            <div className="sm:col-span-2">
              <label className={labelClass}>Emergency note (voluntary — visible to admins only)</label>
              <textarea value={f.emergency_note ?? ''} onChange={set('emergency_note')} rows={3} className={inputClass} />
            </div>
          )}
        </div>
      )}

      {tab === 'Professional' && (
        <div className="space-y-4">
          <div><label className={labelClass}>Certifications</label><textarea value={f.certifications} onChange={set('certifications')} rows={3} className={inputClass} /></div>
          <div><label className={labelClass}>Working hours / shift pattern</label><textarea value={f.working_hours} onChange={set('working_hours')} rows={2} className={inputClass} /></div>
        </div>
      )}

      {tab === 'Leave & Absence' && (
        <div className="text-slate-400 text-sm py-6 text-center">Leave &amp; absence tracking — coming soon.</div>
      )}

      {tab !== 'Leave & Absence' && (
        <div className="mt-5">
          <button onClick={save} disabled={busy} className="bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

export default function ProfileSettings({ email, isSelf, canSeeEmergency, isAdmin, isManager, profile, company, account }: PageProps) {
  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
      <Head><title>Profile - GreaseDesk</title></Head>
      {isSelf ? (
        <p className="text-slate-400 mb-6">Signed in as <strong>{email}</strong>{account ? ` · ${account.ref}` : ''}</p>
      ) : (
        <p className="text-slate-400 mb-6">Editing <strong>{profile.name || profile.email}</strong> (admin)</p>
      )}

      {isSelf && account && <AccountRef account={account} />}
      {isSelf && <ChangePassword />}
      {isSelf && company && <CompanyDetails company={company} isAdmin={isAdmin} />}

      <ProfileTabs profile={profile} isSelf={isSelf} canSeeEmergency={canSeeEmergency} />
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id || !sUser?.group_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  const vis = await getVisibility(sUser.id as string);
  const wanted = (ctx.query.user as string) || (sUser.id as string);
  const isSelf = wanted === sUser.id;

  // Only self, or an admin viewing someone in their own group, may open a profile.
  if (!isSelf && !vis.isAdmin) {
    return { redirect: { destination: '/admin/settings/profile', permanent: false } };
  }

  const u = (await prisma.user.findFirst({
    where: isSelf ? { id: sUser.id } : { id: wanted, group_id: sUser.group_id },
    select: {
      id: true, name: true, email: true, job_title: true, start_date: true, phone: true, address: true,
      driving_licence_categories: true, next_of_kin_name: true, next_of_kin_relationship: true,
      next_of_kin_phone: true, emergency_note: true, certifications: true, working_hours: true,
    },
  })) as any;
  if (!u) return { redirect: { destination: '/admin/settings/profile', permanent: false } };

  const canSeeEmergency = isSelf || vis.isAdmin;
  const s = (v: any) => (v == null ? '' : String(v));
  const profile: Profile = {
    id: u.id, name: s(u.name), email: s(u.email), job_title: s(u.job_title),
    start_date: u.start_date ? new Date(u.start_date).toISOString().slice(0, 10) : '',
    phone: s(u.phone), address: s(u.address), driving_licence_categories: s(u.driving_licence_categories),
    next_of_kin_name: s(u.next_of_kin_name), next_of_kin_relationship: s(u.next_of_kin_relationship),
    next_of_kin_phone: s(u.next_of_kin_phone), certifications: s(u.certifications), working_hours: s(u.working_hours),
    ...(canSeeEmergency ? { emergency_note: s(u.emergency_note) } : {}),
  };

  // Self-only extras (account + company).
  let company: Company | null = null;
  let account: Account | null = null;
  if (isSelf) {
    const g = (await prisma.group.findUnique({
      where: { id: sUser.group_id },
      select: { group_name: true, company_number: true, vat_number: true, ref: true, status: true, trial_ends_at: true },
    })) as any;
    company = g ? { group_name: g.group_name, company_number: g.company_number, vat_number: g.vat_number } : null;
    account = g ? { ref: g.ref, status: g.status, trialEndsAt: g.trial_ends_at ? g.trial_ends_at.toISOString() : null } : null;
  }

  return {
    props: { email: s(sUser.email), isSelf, canSeeEmergency, isAdmin: vis.isAdmin, isManager: vis.role === 'SITE_MANAGER', profile, company, account },
  };
};
