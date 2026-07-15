/**
 * File: pages/superadmin/tenants.tsx
 * SuperAdmin operator console — the tenant list + Archive/Purge. STANDALONE: not under /admin, so
 * _app never wraps it in AdminLayout; it shares no code path with tenant authority. Operator-only
 * (requireSuperAdminPage → 404 for everyone else, so a tenant admin can't discover it exists).
 * Read-only table; every tenant shows ref AND id (two groups share a name — never identify by name).
 */
import { useState } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireSuperAdminPage, TMBS_GROUP_ID } from '@/lib/superadmin';

type TenantRow = {
  id: string; name: string; ref: string; created: string; archivedAt: string | null;
  subscriptionStatus: string | null; siteCount: number; userCount: number; lastActivity: string | null; isTmbs: boolean; isOwn: boolean;
};
type PageProps = { tenants: TenantRow[]; operatorEmail: string };

export default function SuperAdminTenants({ tenants, operatorEmail }: PageProps) {
  const [rows, setRows] = useState(tenants);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [purgeFor, setPurgeFor] = useState<TenantRow | null>(null);
  const [typed, setTyped] = useState('');

  async function call(path: string, body: any): Promise<any> {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function archive(t: TenantRow, unarchive = false) {
    if (!confirm(`${unarchive ? 'Un-archive' : 'Archive'} ${t.name} (${t.ref})?`)) return;
    setBusy(t.id); setMsg(null);
    let r = await call('/api/superadmin/archive', { groupId: t.id, action: unarchive ? 'unarchive' : 'archive' });
    if (!r.ok && r.data?.code === 'tmbs_confirm') {
      if (!confirm(`This is the LIVE TMBS tenant. Really ${unarchive ? 'un-archive' : 'archive'} it?`)) { setBusy(null); return; }
      r = await call('/api/superadmin/archive', { groupId: t.id, action: unarchive ? 'unarchive' : 'archive', confirmTmbs: true });
    }
    setBusy(null);
    if (!r.ok) { setMsg(r.data?.message || 'Failed.'); return; }
    setRows((rs) => rs.map((x) => x.id === t.id ? { ...x, archivedAt: unarchive ? null : new Date().toISOString() } : x));
    setMsg(`${t.name}: ${unarchive ? 'restored' : 'archived'}.`);
  }

  async function doPurge() {
    const t = purgeFor!; setBusy(t.id); setMsg(null);
    let r = await call('/api/superadmin/purge', { groupId: t.id, confirmName: typed });
    if (!r.ok && r.data?.code === 'tmbs_confirm') {
      if (!confirm('This is the LIVE TMBS tenant. Type-name matched — really PURGE it forever?')) { setBusy(null); return; }
      r = await call('/api/superadmin/purge', { groupId: t.id, confirmName: typed, confirmTmbs: true });
    }
    setBusy(null); setPurgeFor(null); setTyped('');
    if (!r.ok) { setMsg(r.data?.message || 'Purge failed.'); return; }
    setRows((rs) => rs.filter((x) => x.id !== t.id));
    setMsg(`${t.name}: PURGED. R2 objects ${r.data?.r2?.deleted ?? '?'}, Stripe ${r.data?.stripe?.canceled ? 'canceled' : 'n/a'}, audit ${r.data?.auditId?.slice(0, 8)}.`);
  }

  return (
    <>
      <Head><title>SuperAdmin · Tenants</title></Head>
      <main className="min-h-screen p-6" style={{ background: '#0B1E3B', color: '#C7D2E1' }}>
        <div className="max-w-6xl mx-auto">
          <div className="flex items-baseline justify-between mb-6">
            <h1 className="text-xl font-semibold text-white">Tenants <span className="text-sm font-normal" style={{ color: '#7C8AA3' }}>· operator {operatorEmail}</span></h1>
            <span className="text-xs" style={{ color: '#7C8AA3' }}>{rows.length} tenants</span>
          </div>
          {msg && <div className="mb-4 text-sm rounded-lg px-3 py-2" style={{ background: '#12294a', border: '1px solid #1C3257' }}>{msg}</div>}
          <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid #1C3257' }}>
            <table className="w-full text-sm">
              <thead style={{ background: '#12294a', color: '#7C8AA3' }}>
                <tr className="text-left">
                  {['Name', 'Ref', 'ID', 'Created', 'Subscription', 'Sites', 'Users', 'Last activity', ''].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} style={{ borderTop: '1px solid #1C3257', opacity: t.archivedAt ? 0.55 : 1 }}>
                    <td className="px-3 py-2 text-white font-medium whitespace-nowrap">{t.name}{t.isTmbs && <span className="ml-1 text-xs" style={{ color: '#FCD34D' }}>★live</span>}{t.archivedAt && <span className="ml-1 text-xs" style={{ color: '#FCA5A5' }}>archived</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.ref}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: '#7C8AA3' }}>{t.id.slice(0, 8)}…</td>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(t.created).toLocaleDateString('en-GB')}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.subscriptionStatus ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{t.siteCount}</td>
                    <td className="px-3 py-2 tabular-nums">{t.userCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{t.lastActivity ? new Date(t.lastActivity).toLocaleString('en-GB') : '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {t.isOwn ? <span className="text-xs" style={{ color: '#7C8AA3' }}>your tenant</span> : (
                        <span className="flex gap-2">
                          <button disabled={busy === t.id} onClick={() => archive(t, !!t.archivedAt)} className="text-xs underline" style={{ color: '#8AB4F8' }}>{t.archivedAt ? 'Un-archive' : 'Archive'}</button>
                          <button disabled={busy === t.id} onClick={() => { setPurgeFor(t); setTyped(''); }} className="text-xs underline" style={{ color: '#FCA5A5' }}>Purge</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {purgeFor && (
          <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setPurgeFor(null)}>
            <div className="max-w-md w-full rounded-xl p-6" style={{ background: '#12294a', border: '1px solid #1C3257' }} onClick={(e) => e.stopPropagation()}>
              <h2 className="text-lg font-semibold text-white mb-2">Purge {purgeFor.name}</h2>
              <p className="text-sm mb-4" style={{ color: '#FCA5A5' }}>Irreversible. Destroys all DB rows, R2 objects, and cancels the Stripe subscription. Type the tenant name to confirm.</p>
              <p className="text-xs mb-2" style={{ color: '#7C8AA3' }}>{purgeFor.ref} · {purgeFor.id}</p>
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={purgeFor.name}
                className="w-full rounded-lg px-3 py-2 text-white mb-4" style={{ background: '#0B1E3B', border: '1px solid #1C3257' }} />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setPurgeFor(null)} className="text-sm px-3 py-2" style={{ color: '#7C8AA3' }}>Cancel</button>
                <button disabled={typed.trim() !== purgeFor.name || busy === purgeFor.id} onClick={doPurge}
                  className="text-sm px-4 py-2 rounded-lg text-white disabled:opacity-40" style={{ background: '#B91C1C' }}>
                  {busy === purgeFor.id ? 'Purging…' : 'Purge forever'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireSuperAdminPage(ctx);
  if (!gate.ok) return { notFound: true }; // 404 — undiscoverable

  const operator = await prisma.user.findUnique({ where: { id: gate.operatorUserId }, select: { email: true, group_id: true } });
  const groups = await prisma.group.findMany({
    orderBy: { created_at: 'desc' },
    select: {
      id: true, group_name: true, ref: true, created_at: true, archived_at: true,
      billing: { select: { subscription_status: true } },
      _count: { select: { sites: true, users: true } },
    },
  });
  const activity = await prisma.auditLog.groupBy({ by: ['group_id'], _max: { created_at: true } });
  const lastByGroup = new Map(activity.map((a: { group_id: string; _max: { created_at: Date | null } }) => [a.group_id, a._max.created_at]));

  return {
    props: {
      operatorEmail: operator?.email ?? '—',
      tenants: groups.map((g: any) => ({
        id: g.id, name: g.group_name, ref: g.ref, created: (g.created_at as Date).toISOString(),
        archivedAt: g.archived_at ? (g.archived_at as Date).toISOString() : null,
        subscriptionStatus: g.billing?.subscription_status ?? null,
        siteCount: g._count.sites, userCount: g._count.users,
        lastActivity: lastByGroup.get(g.id) ? (lastByGroup.get(g.id) as Date).toISOString() : null,
        isTmbs: g.id === TMBS_GROUP_ID, isOwn: g.id === operator?.group_id,
      })),
    },
  };
};
