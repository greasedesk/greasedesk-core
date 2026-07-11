/**
 * File: pages/admin/settings/users/[id].tsx
 * Per-user detail (under the Users tab). Replaces the dissolved standalone Profile: the four
 * profile tabs (Overview / Personal & Safety / Professional / Leave), plus Change Password when
 * you are viewing YOURSELF. Role / site / primary-site editing stays in the roster (users.tsx).
 * Access: self, or an ADMIN viewing a group member (mirrors the old profile.tsx gating). Managers
 * and STANDARD users may only open their own detail. Personal-profile strings stay as-is (this
 * content was pre-i18n before the move); the relocated Company Details page is i18n'd separately.
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

type Profile = {
  id: string; name: string; email: string; job_title: string; start_date: string;
  phone: string; address: string; driving_licence_categories: string;
  next_of_kin_name: string; next_of_kin_relationship: string; next_of_kin_phone: string;
  certifications: string; working_hours: string;
  emergency_note?: string; // present only when the viewer may see it
};
type PageProps = {
  selfId: string;
  isSelf: boolean;
  canSeeEmergency: boolean;
  isAdmin: boolean;
  isManager: boolean;
  profile: Profile;
};

const inputClass = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelClass = 'block text-xs text-muted mb-1';

async function post(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch { return 'Network error.'; }
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-md mb-6">
      <h2 className="text-lg font-semibold text-ink mb-4">Change password</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.type === 'success' ? 'bg-ok text-white' : 'bg-danger text-white'}`}>{msg.text}</div>}
      <form onSubmit={submit} className="space-y-3">
        <div><label className={labelClass}>Current password</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>New password (min 8 characters)</label><input type="password" value={nw} onChange={(e) => setNw(e.target.value)} required className={inputClass} /></div>
        <div><label className={labelClass}>Confirm new password</label><input type="password" value={cf} onChange={(e) => setCf(e.target.value)} required className={inputClass} /></div>
        <button type="submit" disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </div>
  );
}

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
      name: f.name, job_title: f.job_title, phone: f.phone, address: f.address,
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <div className="flex flex-wrap gap-1 border-b border-line mb-5">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm rounded-t-lg ${tab === t ? 'bg-surface-muted text-ink border-b-2 border-accent font-semibold' : 'text-muted hover:text-ink'}`}>{t}</button>
        ))}
      </div>
      {msg && <div className={`p-2 rounded mb-4 text-sm ${msg.type === 'success' ? 'bg-ok text-white' : 'bg-danger text-white'}`}>{msg.text}</div>}

      {tab === 'Overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label className={labelClass}>Full name</label><input value={f.name} onChange={set('name')} className={inputClass} /></div>
          <div><label className={labelClass}>Job title</label><input value={f.job_title} onChange={set('job_title')} className={inputClass} /></div>
          {/* HR (CostPerson) is the SOLE owner of employment dates — read-only echo here. */}
          <div><label className={labelClass}>Start date (managed in HR)</label><input value={f.start_date || '—'} readOnly className={`${inputClass} opacity-60 cursor-not-allowed`} /></div>
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
        <div className="text-muted text-sm py-6 text-center">Leave &amp; absence tracking — coming soon.</div>
      )}

      {tab !== 'Leave & Absence' && (
        <div className="mt-5">
          <button onClick={save} disabled={busy} className="bg-ok hover:bg-ok text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

export default function UserDetail({ selfId, isSelf, canSeeEmergency, isAdmin, isManager, profile }: PageProps) {
  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager} selfUserId={selfId}>
      <Head><title>{isSelf ? 'My account' : profile.name || profile.email} - GreaseDesk</title></Head>
      <p className="text-muted mb-6">
        {isSelf ? <>Your account — <strong>{profile.email}</strong></> : <>Editing <strong>{profile.name || profile.email}</strong> (admin)</>}
      </p>

      {isSelf && <ChangePassword />}
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
  const wanted = String(ctx.params?.id || '');
  const isSelf = wanted === sUser.id;

  // Self always; an ADMIN may open any group member. Others (manager/STANDARD viewing someone
  // else) bounce to their OWN detail — preserves the old profile.tsx admin-only-for-others rule.
  if (!isSelf && !vis.isAdmin) {
    return { redirect: { destination: `/admin/settings/users/${sUser.id}`, permanent: false } };
  }

  const u = (await prisma.user.findFirst({
    where: isSelf ? { id: sUser.id } : { id: wanted, group_id: sUser.group_id },
    select: {
      id: true, name: true, email: true, job_title: true, start_date: true, phone: true, address: true,
      driving_licence_categories: true, next_of_kin_name: true, next_of_kin_relationship: true,
      next_of_kin_phone: true, emergency_note: true, certifications: true, working_hours: true,
    },
  })) as any;
  if (!u) return { redirect: { destination: `/admin/settings/users/${sUser.id}`, permanent: false } };
  // HR record (CostPerson.user_id link) is the employment-date owner; legacy User.start_date is
  // only a display fallback for unlinked people.
  const hrRow = (await prisma.costPerson.findFirst({ where: { user_id: u.id }, select: { start_date: true } })) as any;
  const hrStart = hrRow?.start_date ? new Date(hrRow.start_date).toISOString().slice(0, 10) : null;

  const canSeeEmergency = isSelf || vis.isAdmin;
  const s = (v: any) => (v == null ? '' : String(v));
  const profile: Profile = {
    id: u.id, name: s(u.name), email: s(u.email), job_title: s(u.job_title),
    start_date: hrStart ?? (u.start_date ? new Date(u.start_date).toISOString().slice(0, 10) : ''),
    phone: s(u.phone), address: s(u.address), driving_licence_categories: s(u.driving_licence_categories),
    next_of_kin_name: s(u.next_of_kin_name), next_of_kin_relationship: s(u.next_of_kin_relationship),
    next_of_kin_phone: s(u.next_of_kin_phone), certifications: s(u.certifications), working_hours: s(u.working_hours),
    ...(canSeeEmergency ? { emergency_note: s(u.emergency_note) } : {}),
  };

  return {
    props: {
      selfId: sUser.id as string, isSelf, canSeeEmergency,
      isAdmin: vis.isAdmin, isManager: vis.role === 'SITE_MANAGER', profile,
    },
  };
};
