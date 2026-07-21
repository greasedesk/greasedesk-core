/**
 * File: pages/superadmin/operators.tsx
 * Operator management — OWNER ONLY (getServerSideProps enforces minRole 'owner'; the nav link is
 * hidden for others AND this page 404s them — hidden link is not a guard). Create / edit-role /
 * edit-regions / suspend / un-suspend. No delete. All mutations go through /api/superadmin/operators,
 * which re-enforces owner-only, the lockout invariants, and the audit trail server-side; the UI is a
 * convenience over those guards, never a substitute.
 */
import { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Op = {
  id: string; email: string; name: string; role: OperatorRoleName; regions: string[]; status: string;
  suspendedAt: string | null; createdAt: string; lastLoginAt: string | null; pending: boolean; isSelf: boolean;
};
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', country_manager: 'Country manager', support: 'Support' };

export default function Operators({ role, initial }: { role: OperatorRoleName; initial: Op[] }) {
  const [ops, setOps] = useState<Op[]>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // create form
  const [email, setEmail] = useState(''); const [name, setName] = useState('');
  const [newRole, setNewRole] = useState<OperatorRoleName>('support'); const [regions, setRegions] = useState('GB');

  async function refresh() { const r = await fetch('/api/superadmin/operators'); if (r.ok) setOps((await r.json()).operators); }
  async function call(method: string, body: any): Promise<boolean> {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/superadmin/operators', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg({ ok: r.ok, text: d.message || (r.ok ? 'Done.' : 'Failed.') });
    if (r.ok) await refresh();
    return r.ok;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const regs = newRole === 'owner' ? [] : regions.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (await call('POST', { email, name, role: newRole, regions: regs })) { setEmail(''); setName(''); setNewRole('support'); setRegions('GB'); }
  }
  const changeRole = (o: Op, r: string) => call('PATCH', { id: o.id, action: 'role', role: r });
  const changeRegions = (o: Op) => { const v = prompt(`Regions for ${o.email} (comma-separated ISO-2)`, o.regions.join(',')); if (v != null) call('PATCH', { id: o.id, action: 'regions', regions: v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) }); };
  const suspend = (o: Op) => { const reason = prompt(`Reason for suspending ${o.email}?`); if (reason) call('PATCH', { id: o.id, action: 'suspend', reason }); };
  const unsuspend = (o: Op) => call('PATCH', { id: o.id, action: 'unsuspend' });

  const input = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — operators</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-5xl">
        <h1 className="text-xl font-semibold mb-4">Operators</h1>
        {msg && <div className={`mb-4 text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}

        {/* Create */}
        <form onSubmit={create} className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-4 flex flex-wrap items-end gap-3">
          <div><label className="block text-xs text-slate-400 mb-1">Email</label><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} placeholder="name@greasedesk.com" /></div>
          <div><label className="block text-xs text-slate-400 mb-1">Name</label><input required value={name} onChange={(e) => setName(e.target.value)} className={input} /></div>
          <div><label className="block text-xs text-slate-400 mb-1">Role</label>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as OperatorRoleName)} className={input}>
              <option value="support">Support</option><option value="country_manager">Country manager</option><option value="owner">Owner</option>
            </select>
          </div>
          <div><label className="block text-xs text-slate-400 mb-1">Regions {newRole === 'owner' && <span className="text-slate-600">(n/a)</span>}</label>
            <input value={newRole === 'owner' ? '' : regions} disabled={newRole === 'owner'} onChange={(e) => setRegions(e.target.value)} className={`${input} disabled:opacity-40`} placeholder="GB,IE" /></div>
          <button disabled={busy} className="bg-slate-100 text-slate-900 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">Invite operator</button>
        </form>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400"><tr className="text-left">
              {['Name', 'Email', 'Role', 'Regions', 'Status', 'Last login', 'Created', ''].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
            </tr></thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-white whitespace-nowrap">{o.name}{o.isSelf && <span className="ml-1 text-[10px] text-slate-500">you</span>}{o.pending && <span className="ml-1 text-[10px] text-amber-400">pending</span>}</td>
                  <td className="px-3 py-2 text-slate-300">{o.email}</td>
                  <td className="px-3 py-2">
                    <select value={o.role} disabled={busy} onChange={(e) => changeRole(o, e.target.value)} className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100">
                      <option value="support">Support</option><option value="country_manager">Country manager</option><option value="owner">Owner</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {o.role === 'owner' ? <span className="text-slate-600">all</span> : (
                      <button onClick={() => changeRegions(o)} className="underline decoration-dotted text-slate-300 hover:text-white">{o.regions.join(', ') || '—'}</button>
                    )}
                  </td>
                  <td className="px-3 py-2">{o.status === 'suspended' ? <span className="text-red-400">suspended</span> : <span className="text-emerald-400">active</span>}</td>
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{o.lastLoginAt ? new Date(o.lastLoginAt).toLocaleString('en-GB') : '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{new Date(o.createdAt).toLocaleDateString('en-GB')}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {o.status === 'suspended'
                      ? <button disabled={busy} onClick={() => unsuspend(o)} className="text-xs underline text-emerald-300">Un-suspend</button>
                      : <button disabled={busy || o.isSelf} onClick={() => suspend(o)} className="text-xs underline text-red-300 disabled:opacity-30">Suspend</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">No delete — operators are suspended, never removed, so the audit trail of what they did survives.</p>
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/operators') }); // owner
  if (!gate.ok) return { notFound: true };
  const { prisma } = await import('@/lib/db');
  const rows = await prisma.operator.findMany({
    orderBy: { created_at: 'asc' },
    select: { id: true, email: true, name: true, role: true, regions: true, status: true, suspended_at: true, created_at: true, last_login_at: true, passwordHash: true, invite_token_used_at: true },
  });
  return {
    props: {
      role: gate.op.role,
      initial: rows.map((o: any) => ({
        id: o.id, email: o.email, name: o.name, role: o.role, regions: o.regions, status: o.status,
        suspendedAt: o.suspended_at ? o.suspended_at.toISOString() : null,
        createdAt: o.created_at.toISOString(), lastLoginAt: o.last_login_at ? o.last_login_at.toISOString() : null,
        pending: o.passwordHash === 'INVITE_PENDING' && !o.invite_token_used_at, isSelf: o.id === gate.op.userId,
      })),
    },
  };
};
