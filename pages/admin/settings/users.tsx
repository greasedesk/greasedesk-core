/**
 * File: pages/admin/settings/users.tsx
 * Settings → Users. Manage the group's users and which site(s) each is assigned to
 * (many-to-many). Assignment only — no roles / no visibility enforcement yet.
 * CRUD via /api/users. Group-scoped; remove is guarded (not self, not last user).
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';

type SiteOpt = { id: string; name: string };
type UserRow = { id: string; name: string | null; email: string; isActive: boolean; siteIds: string[]; role: 'ADMIN' | 'STANDARD'; isOwner: boolean };
type PageProps = { users: UserRow[]; sites: SiteOpt[]; selfId: string | null; isAdmin: boolean };

function RoleBadge({ role }: { role: 'ADMIN' | 'STANDARD' }) {
  return (
    <span className={`ml-2 text-xs px-2 py-0.5 rounded-full border ${role === 'ADMIN' ? 'bg-purple-900 text-purple-200 border-purple-700' : 'bg-slate-700 text-slate-300 border-slate-600'}`}>
      {role}
    </span>
  );
}

const inputClass = 'p-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:ring-blue-500 focus:border-blue-500';

async function mutate(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch {
    return 'Network error.';
  }
}

function SiteCheboxes({ sites, selected, onToggle }: { sites: SiteOpt[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {sites.map((s) => (
        <label key={s.id} className="flex items-center gap-1 text-xs text-slate-200 bg-slate-700 border border-slate-600 rounded px-2 py-1">
          <input type="checkbox" checked={selected.includes(s.id)} onChange={() => onToggle(s.id)} />
          {s.name}
        </label>
      ))}
      {sites.length === 0 && <span className="text-xs text-slate-500">No locations yet.</span>}
    </div>
  );
}

function AddUser({ sites, onChanged }: { sites: SiteOpt[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSiteIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/users', 'POST', { name, email, siteIds });
    setBusy(false);
    if (error) return setErr(error);
    setName(''); setEmail(''); setSiteIds([]);
    onChanged();
  }

  return (
    <form onSubmit={submit} className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6 space-y-3">
      <h2 className="text-lg font-semibold text-white">Add a user</h2>
      <div className="flex flex-wrap gap-3">
        <div><label className="block text-xs text-slate-400 mb-1">Name</label><input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-48`} /></div>
        <div><label className="block text-xs text-slate-400 mb-1">Email *</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={`${inputClass} w-64`} /></div>
      </div>
      <div>
        <label className="block text-xs text-slate-400 mb-1">Assign to location(s)</label>
        <SiteCheboxes sites={sites} selected={siteIds} onToggle={toggle} />
      </div>
      {err && <div className="bg-red-700 text-red-100 p-2 rounded text-sm">{err}</div>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
          {busy ? 'Adding…' : 'Add user'}
        </button>
        <span className="text-xs text-amber-300">The user is created as <strong>pending</strong> — no invite email is sent yet (coming with the auth slice).</span>
      </div>
    </form>
  );
}

function UserCard({ user, sites, selfId, isAdmin, onChanged }: { user: UserRow; sites: SiteOpt[]; selfId: string | null; isAdmin: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name ?? '');
  const [siteIds, setSiteIds] = useState<string[]>(user.siteIds);
  const [role, setRole] = useState<'ADMIN' | 'STANDARD'>(user.role);
  const [err, setErr] = useState<string | null>(null);
  const isSelf = selfId === user.id;
  const toggle = (id: string) => setSiteIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const nameFor = (id: string) => sites.find((s) => s.id === id)?.name ?? '—';
  // The owner's role is locked; only an ADMIN may change a (non-owner) user's role.
  const canEditRole = isAdmin && !user.isOwner;

  async function save() {
    const body: any = { id: user.id, name, siteIds };
    if (canEditRole) body.role = role;
    const error = await mutate('/api/users', 'PATCH', body);
    if (error) return setErr(error);
    setEditing(false);
    onChanged();
  }
  async function remove() {
    const error = await mutate('/api/users', 'DELETE', { id: user.id });
    if (error) return setErr(error); // 409 guard surfaced
    onChanged();
  }

  const removeDisabled = isSelf || user.isOwner;
  const removeTitle = user.isOwner ? 'The owner account cannot be removed' : isSelf ? 'You cannot remove yourself' : 'Remove user';

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-white font-medium flex flex-wrap items-center">
            {user.name || <span className="text-slate-400 italic">No name</span>}
            <RoleBadge role={user.role} />
            {user.isOwner && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-emerald-900 text-emerald-200 border border-emerald-700">owner</span>}
            {isSelf && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-900 text-blue-200 border border-blue-700">you</span>}
            {!user.isActive && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-900 text-amber-200 border border-amber-700">pending</span>}
          </div>
          <div className="text-slate-400 text-sm">{user.email}</div>
          {!editing && (
            <div className="text-slate-300 text-sm mt-1">
              Sites: {user.siteIds.length ? user.siteIds.map(nameFor).join(', ') : <span className="text-slate-500">none</span>}
            </div>
          )}
        </div>
        {isAdmin && !editing && (
          <div className="flex items-center gap-3 shrink-0">
            <Link href={`/admin/settings/profile?user=${user.id}`} className="text-xs text-blue-400 hover:underline">Profile</Link>
            <button onClick={() => setEditing(true)} className="text-xs text-blue-400 hover:underline">Edit</button>
            <button onClick={remove} disabled={removeDisabled} title={removeTitle} className={`text-xs ${removeDisabled ? 'text-slate-600 cursor-not-allowed' : 'text-red-400 hover:underline'}`}>Remove</button>
          </div>
        )}
      </div>

      {isAdmin && editing && (
        <div className="mt-3 space-y-3">
          <div><label className="block text-xs text-slate-400 mb-1">Name</label><input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-64`} /></div>
          {canEditRole ? (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as 'ADMIN' | 'STANDARD')} className={inputClass}>
                <option value="STANDARD">Standard</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
          ) : (
            <div className="text-xs text-slate-400">
              Role: <span className="text-slate-200">{user.role}</span>
              {user.isOwner ? ' (owner — locked)' : !isAdmin ? ' (only an admin can change roles)' : ''}
            </div>
          )}
          <div><label className="block text-xs text-slate-400 mb-1">Assigned location(s)</label><SiteCheboxes sites={sites} selected={siteIds} onToggle={toggle} /></div>
          <div className="flex items-center gap-2">
            <button onClick={save} className="text-xs bg-green-600 hover:bg-green-500 text-white rounded px-3 py-1.5">Save</button>
            <button onClick={() => { setEditing(false); setName(user.name ?? ''); setSiteIds(user.siteIds); setRole(user.role); }} className="text-xs text-slate-400 hover:text-white px-2">Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="text-red-400 text-xs mt-2">{err}</div>}
    </div>
  );
}

export default function UsersSettings({ users, sites, selfId, isAdmin }: PageProps) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  return (
    <SettingsLayout isAdmin={isAdmin}>
      <Head><title>Users - GreaseDesk</title></Head>
      <p className="text-slate-400 mb-6">
        Manage your users, their role (Admin / Standard), and which location(s) each is assigned to.
        Site visibility is not yet enforced by role — that’s a later slice. {isAdmin ? '' : 'Only an admin can change roles.'}
      </p>

      {isAdmin && <AddUser sites={sites} onChanged={refresh} />}

      {users.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center text-slate-400">No users.</div>
      ) : (
        users.map((u) => <UserCard key={u.id} user={u} sites={sites} selfId={selfId} isAdmin={isAdmin} onChanged={refresh} />)
      )}
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  // ADMIN-ONLY: the roster (other users' details) is never served to a STANDARD user — the page
  // redirects before any user query runs. /api/users also refuses non-admins on every method.
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;

  type UserDbRow = { id: string; name: string | null; email: string; is_active: boolean; role: 'ADMIN' | 'STANDARD'; is_owner: boolean; site_assignments: { site_id: string }[] };
  const selfId = vis.userId;
  const [userRows, siteRows] = await Promise.all([
    prisma.user.findMany({
      where: { group_id: vis.groupId },
      orderBy: { email: 'asc' },
      select: { id: true, name: true, email: true, is_active: true, role: true, is_owner: true, site_assignments: { select: { site_id: true } } },
    }) as Promise<UserDbRow[]>,
    prisma.site.findMany({ where: { group_id: vis.groupId }, orderBy: { site_name: 'asc' }, select: { id: true, site_name: true } }),
  ]);

  const users: UserRow[] = userRows.map((u: UserDbRow) => ({
    id: u.id, name: u.name, email: u.email, isActive: u.is_active, role: u.role, isOwner: u.is_owner,
    siteIds: u.site_assignments.map((a) => a.site_id),
  }));
  const sites: SiteOpt[] = (siteRows as Array<{ id: string; site_name: string }>).map((s) => ({ id: s.id, name: s.site_name }));

  return { props: { users, sites, selfId, isAdmin: vis.isAdmin } };
};
