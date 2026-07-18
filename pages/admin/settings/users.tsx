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
import { useTranslation } from 'next-i18next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireSiteManagerPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';

type Role = 'ADMIN' | 'SITE_MANAGER' | 'STANDARD';
type SiteOpt = { id: string; name: string };
type UserRow = { id: string; name: string | null; email: string; isActive: boolean; deactivatedAt: string | null; siteIds: string[]; role: Role; isOwner: boolean; primarySiteId: string | null; canInvoice: boolean };
type PageProps = { users: UserRow[]; sites: SiteOpt[]; selfId: string | null; isAdmin: boolean; isManager: boolean };

const ROLE_LABEL: Record<Role, string> = { ADMIN: 'ADMIN', SITE_MANAGER: 'SITE MANAGER', STANDARD: 'STANDARD' };

function RoleBadge({ role }: { role: Role }) {
  const cls = role === 'ADMIN'
    ? 'bg-accent-soft text-accent border-line'
    : role === 'SITE_MANAGER'
      ? 'bg-warn-soft text-warn border-line'
      : 'bg-surface-muted text-muted border-line';
  return <span className={`ml-2 text-xs px-2 py-0.5 rounded-full border ${cls}`}>{ROLE_LABEL[role]}</span>;
}

const inputClass = 'p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';

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
        <label key={s.id} className="flex items-center gap-1 text-xs text-ink bg-surface-muted border border-line rounded px-2 py-1">
          <input type="checkbox" checked={selected.includes(s.id)} onChange={() => onToggle(s.id)} />
          {s.name}
        </label>
      ))}
      {sites.length === 0 && <span className="text-xs text-muted">No locations yet.</span>}
    </div>
  );
}

function AddUser({ sites, onChanged }: { sites: SiteOpt[]; onChanged: () => void }) {
  const { t } = useTranslation('users');
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
    <form onSubmit={submit} className="bg-surface border border-line rounded-xl p-4 mb-6 space-y-3">
      <h2 className="text-lg font-semibold text-ink">Add a user</h2>
      <div className="flex flex-wrap gap-3">
        <div><label className="block text-xs text-muted mb-1">Name</label><input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-48`} /></div>
        <div><label className="block text-xs text-muted mb-1">Email *</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={`${inputClass} w-64`} /></div>
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Assign to location(s)</label>
        <SiteCheboxes sites={sites} selected={siteIds} onToggle={toggle} />
      </div>
      {err && <div className="bg-danger text-white p-2 rounded text-sm">{err}</div>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
          {busy ? 'Adding…' : 'Add user'}
        </button>
        <span className="text-xs text-muted">{t('inviteInfo')}</span>
      </div>
    </form>
  );
}

function UserCard({ user, sites, selfId, isAdmin, isManager, onChanged }: { user: UserRow; sites: SiteOpt[]; selfId: string | null; isAdmin: boolean; isManager: boolean; onChanged: () => void }) {
  const { t } = useTranslation('users');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name ?? '');
  const [siteIds, setSiteIds] = useState<string[]>(user.siteIds);
  const [primary, setPrimary] = useState<string>(user.primarySiteId ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [canInvoice, setCanInvoice] = useState<boolean>(user.canInvoice);
  const [err, setErr] = useState<string | null>(null);
  const isSelf = selfId === user.id;
  const toggle = (id: string) => setSiteIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const nameFor = (id: string) => sites.find((s) => s.id === id)?.name ?? '—';
  // Who may act on THIS user: admin → anyone; site-manager → only a STANDARD non-owner (the roster
  // they're shown is already scoped to their sites; the server re-checks).
  const canManage = isAdmin || (isManager && user.role === 'STANDARD' && !user.isOwner);
  // The owner's role is locked; only an ADMIN may change a (non-owner) user's role / grant tiers.
  const canEditRole = isAdmin && !user.isOwner;

  async function save() {
    const body: any = { id: user.id, name, siteIds };
    if (canEditRole) body.role = role;
    if (canEditRole) body.canInvoice = canInvoice; // ADMIN-only grant (server re-checks)
    // Primary must be one of the selected sites; else fall back to auto (first assigned).
    body.primarySiteId = siteIds.includes(primary) ? primary : null;
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
  // REVERSIBLE alternative to Remove. Deactivating blocks login AND kills live sessions, but keeps
  // the account and every audit attribution intact — deleting nulls the trail (onDelete: SetNull).
  async function setActive(next: boolean) {
    const who = user.name || user.email;
    const msg = next
      ? `Reactivate ${who}?\n\nThey'll be able to sign in again.`
      : `Deactivate ${who}?\n\nThey'll be signed out everywhere immediately and won't be able to sign in. Their history is kept and you can reactivate them at any time.`;
    if (!confirm(msg)) return;
    const error = await mutate('/api/users', 'PATCH', { id: user.id, isActive: next });
    if (error) return setErr(error); // 409 lockout guards surfaced
    onChanged();
  }

  const removeDisabled = isSelf || user.isOwner;
  const removeTitle = user.isOwner ? 'The owner account cannot be removed' : isSelf ? 'You cannot remove yourself' : 'Remove user';
  // Mirrors the server's lockout guards, so a disabled control never becomes a 409.
  const deactivateDisabled = isSelf || user.isOwner;
  const deactivateTitle = user.isOwner ? 'The owner account cannot be deactivated' : isSelf ? 'You cannot deactivate yourself' : 'Block sign-in and end all sessions';

  return (
    <div className="bg-surface border border-line rounded-xl p-4 mb-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ink font-medium flex flex-wrap items-center">
            {user.name || <span className="text-muted italic">No name</span>}
            <RoleBadge role={user.role} />
            {user.isOwner && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-ok-soft text-ok border border-line">owner</span>}
            {isSelf && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent border border-line">you</span>}
            {/* is_active=false means two different things; deactivated_at is what tells them apart. */}
            {!user.isActive && (user.deactivatedAt
              ? <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-danger-soft text-danger border border-line">deactivated</span>
              : <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warn-soft text-warn border border-line">pending invite</span>)}
          </div>
          <div className="text-muted text-sm">{user.email}</div>
          {!editing && (
            <div className="text-muted text-sm mt-1">
              Sites: {user.siteIds.length ? user.siteIds.map(nameFor).join(', ') : <span className="text-muted">none</span>}
            </div>
          )}
        </div>
        {canManage && !editing && (
          <div className="flex items-center gap-3 shrink-0">
            <Link href={`/admin/settings/users/${user.id}`} className="text-xs text-accent hover:underline">Profile</Link>
            <button onClick={() => setEditing(true)} className="text-xs text-accent hover:underline">Edit</button>
            {/* ADMIN-only (the server rejects managers), and offered BEFORE Remove: suspending is
                reversible and keeps the audit trail, so it should be the easier reach of the two. */}
            {isAdmin && (user.isActive ? (
              <button onClick={() => setActive(false)} disabled={deactivateDisabled} title={deactivateTitle} className={`text-xs ${deactivateDisabled ? 'text-muted cursor-not-allowed' : 'text-warn hover:underline'}`}>Deactivate</button>
            ) : user.deactivatedAt ? (
              <button onClick={() => setActive(true)} title="Allow this user to sign in again" className="text-xs text-ok hover:underline">Reactivate</button>
            ) : null)}
            <button onClick={remove} disabled={removeDisabled} title={removeTitle} className={`text-xs ${removeDisabled ? 'text-muted cursor-not-allowed' : 'text-danger hover:underline'}`}>Remove</button>
          </div>
        )}
      </div>

      {canManage && editing && (
        <div className="mt-3 space-y-3">
          <div><label className="block text-xs text-muted mb-1">Name</label><input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-64`} /></div>
          {canEditRole ? (
            <div>
              <label className="block text-xs text-muted mb-1">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
                <option value="STANDARD">Standard</option>
                <option value="SITE_MANAGER">Site manager</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
          ) : (
            <div className="text-xs text-muted">
              Role: <span className="text-ink">{ROLE_LABEL[user.role]}</span>
              {user.isOwner ? ' (owner — locked)' : ' (only an admin can change roles)'}
            </div>
          )}
          <div><label className="block text-xs text-muted mb-1">Assigned location(s)</label><SiteCheboxes sites={sites} selected={siteIds} onToggle={toggle} /></div>
          {siteIds.length > 1 && (
            <div>
              <label className="block text-xs text-muted mb-1">{t('primary.label')}</label>
              <select value={siteIds.includes(primary) ? primary : ''} onChange={(e) => setPrimary(e.target.value)} className={inputClass}>
                <option value="">{t('primary.auto')}</option>
                {siteIds.map((id) => <option key={id} value={id}>{nameFor(id)}</option>)}
              </select>
            </div>
          )}
          {canEditRole && (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="w-4 h-4 mt-0.5" checked={canInvoice} onChange={(e) => setCanInvoice(e.target.checked)} />
              <span className="text-ink">Can raise invoices
                <span className="block text-muted">Issue an invoice on jobs at their location. Does not grant mark-paid, unlock, or cost/margin visibility.</span>
              </span>
            </label>
          )}
          <div className="flex items-center gap-2">
            <button onClick={save} className="text-xs bg-ok hover:bg-ok text-white rounded px-3 py-1.5">Save</button>
            <button onClick={() => { setEditing(false); setName(user.name ?? ''); setSiteIds(user.siteIds); setPrimary(user.primarySiteId ?? ''); setRole(user.role); setCanInvoice(user.canInvoice); }} className="text-xs text-muted hover:text-ink px-2">Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="text-danger text-xs mt-2">{err}</div>}
    </div>
  );
}

export default function UsersSettings({ users, sites, selfId, isAdmin, isManager }: PageProps) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
      <Head><title>Users - GreaseDesk</title></Head>
      <div className="flex items-start justify-between gap-4 mb-6">
        <p className="text-muted">
          {isAdmin
            ? 'Manage your users, their role (Admin / Site manager / Standard), and which location(s) each is assigned to.'
            : 'Manage the standard users at your location(s) and which location(s) each is assigned to. Only an admin can grant the site-manager or admin role.'}
        </p>
        {selfId && (
          <Link href={`/admin/settings/users/${selfId}`} className="shrink-0 text-sm text-accent hover:underline whitespace-nowrap">
            My account →
          </Link>
        )}
      </div>

      {(isAdmin || isManager) && <AddUser sites={sites} onChanged={refresh} />}

      {users.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-8 text-center text-muted">No users.</div>
      ) : (
        users.map((u) => <UserCard key={u.id} user={u} sites={sites} selfId={selfId} isAdmin={isAdmin} isManager={isManager} onChanged={refresh} />)
      )}
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['users'])(async (ctx) => {
  // ADMIN or SITE_MANAGER only — STANDARD users are redirected (never receive the roster).
  // /api/users also refuses STANDARD on every method. Managers see only STANDARD users at THEIR
  // sites, and only their own sites in the assignment pickers.
  const gate = await requireSiteManagerPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;
  const isAdmin = vis.isAdmin;

  type UserDbRow = { id: string; name: string | null; email: string; is_active: boolean; deactivated_at: Date | null; role: Role; is_owner: boolean; primary_site_id: string | null; can_invoice: boolean; site_assignments: { site_id: string }[] };
  const selfId = vis.userId;
  const userWhere = isAdmin
    ? { group_id: vis.groupId }
    : { group_id: vis.groupId, role: 'STANDARD' as Role, site_assignments: { some: { site_id: { in: vis.siteIds } } } };
  const siteWhere = isAdmin
    ? { group_id: vis.groupId }
    : { group_id: vis.groupId, id: { in: vis.activeSiteIds } }; // assignable = ACTIVE locations only
  const [userRows, siteRows] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      orderBy: { email: 'asc' },
      select: { id: true, name: true, email: true, is_active: true, deactivated_at: true, role: true, is_owner: true, primary_site_id: true, can_invoice: true, site_assignments: { select: { site_id: true } } },
    }) as Promise<UserDbRow[]>,
    prisma.site.findMany({ where: siteWhere, orderBy: { site_name: 'asc' }, select: { id: true, site_name: true } }),
  ]);

  const users: UserRow[] = userRows.map((u: UserDbRow) => ({
    id: u.id, name: u.name, email: u.email, isActive: u.is_active,
    deactivatedAt: u.deactivated_at ? u.deactivated_at.toISOString() : null,
    role: u.role, isOwner: u.is_owner,
    siteIds: u.site_assignments.map((a) => a.site_id),
    primarySiteId: u.primary_site_id ?? null,
    canInvoice: !!u.can_invoice,
  }));
  const sites: SiteOpt[] = (siteRows as Array<{ id: string; site_name: string }>).map((s) => ({ id: s.id, name: s.site_name }));

  return { props: { users, sites, selfId, isAdmin, isManager: vis.role === 'SITE_MANAGER' } };
});
