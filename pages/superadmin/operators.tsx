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
  twoFactorEnabled: boolean;
};
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', country_manager: 'Country manager', support: 'Support' };

export default function Operators({ role, initial }: { role: OperatorRoleName; initial: Op[] }) {
  const [ops, setOps] = useState<Op[]>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // create form
  const [email, setEmail] = useState(''); const [name, setName] = useState('');
  const [newRole, setNewRole] = useState<OperatorRoleName>('support'); const [regions, setRegions] = useState('GB');
  const [created, setCreated] = useState<{ email: string; link: string; emailSent: boolean } | null>(null);

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
    setBusy(true); setMsg(null); setCreated(null);
    const r = await fetch('/api/superadmin/operators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name, role: newRole, regions: regs }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: d.message || 'Failed.' }); return; }
    // Surface the set-password link on screen — the operator sets their own password from it (works
    // even when their mailbox doesn't exist yet). Emailed too when Resend delivered.
    setCreated({ email: d.operatorEmail || email, link: d.setupLink, emailSent: !!d.emailSent });
    setEmail(''); setName(''); setNewRole('support'); setRegions('GB');
    await refresh();
  }
  const changeRole = (o: Op, r: string) => call('PATCH', { id: o.id, action: 'role', role: r });
  const changeRegions = (o: Op) => { const v = prompt(`Regions for ${o.email} (comma-separated ISO-2)`, o.regions.join(',')); if (v != null) call('PATCH', { id: o.id, action: 'regions', regions: v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) }); };
  const suspend = (o: Op) => { const reason = prompt(`Reason for suspending ${o.email}?`); if (reason) call('PATCH', { id: o.id, action: 'suspend', reason }); };
  const unsuspend = (o: Op) => call('PATCH', { id: o.id, action: 'unsuspend' });
  const reset2fa = (o: Op) => { if (confirm(`Reset two-factor authentication for ${o.email}?\n\nThey will sign in with their password alone and must re-enrol. Use this ONLY for a lost device + lost recovery codes — it lowers their account to single-factor until they re-enrol.`)) call('PATCH', { id: o.id, action: 'reset_2fa' }); };

  const input = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — operators</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-5xl">
        <h1 className="text-xl font-semibold mb-4">Operators</h1>
        {msg && <div className={`mb-4 text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}
        {created && (
          <div className="mb-4 rounded-xl border border-emerald-800 bg-emerald-950/60 p-4">
            <div className="text-sm text-emerald-200 mb-2">
              Created <span className="font-semibold text-white">{created.email}</span>. {created.emailSent ? 'A set-password email was sent — and' : 'Email not delivered;'} share this one-time set-password link with them:
            </div>
            <div className="flex gap-2 items-center">
              <input readOnly value={created.link} onClick={(e) => (e.target as HTMLInputElement).select()} className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono" />
              <button onClick={() => { navigator.clipboard?.writeText(created.link); setMsg({ ok: true, text: 'Link copied.' }); }} className="bg-slate-100 text-slate-900 rounded-lg px-3 py-2 text-xs font-medium">Copy</button>
              <button onClick={() => setCreated(null)} className="text-slate-400 text-xs px-2">Dismiss</button>
            </div>
            <div className="text-[11px] text-slate-500 mt-2">Single-use · expires in 5 days. They set their own password — you never see it.</div>
          </div>
        )}

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

        {/* Compact 6-column layout so the ACTION is always visible without horizontal scroll — the
            Suspend/Un-suspend control lives in its own right-hand column as a real button, not a
            far-right link that scrolled off the old 8-column table. */}
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400"><tr className="text-left">
              {['Operator', 'Role', 'Regions', 'Status', 'Last login', 'Action'].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
            </tr></thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.id} className={`border-t border-slate-800 ${o.status === 'suspended' ? 'bg-red-950/30' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="text-white whitespace-nowrap">{o.name}{o.isSelf && <span className="ml-1 text-[10px] text-slate-500">you</span>}{o.pending && <span className="ml-1 text-[10px] text-amber-400">pending</span>}{o.twoFactorEnabled && <span className="ml-1 text-[10px] text-emerald-400" title="Two-factor authentication is on">🔒 2FA</span>}</div>
                    <div className="text-xs text-slate-400">{o.email}</div>
                  </td>
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
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${o.status === 'suspended' ? 'bg-red-900/60 text-red-200 border border-red-700' : 'bg-emerald-900/50 text-emerald-200 border border-emerald-800'}`}>
                      {o.status === 'suspended' ? 'Suspended' : 'Active'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{o.lastLoginAt ? new Date(o.lastLoginAt).toLocaleString('en-GB') : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex gap-2">
                      {o.status === 'suspended'
                        ? <button disabled={busy} onClick={() => unsuspend(o)} className="rounded-lg border border-emerald-700 text-emerald-200 hover:bg-emerald-900/40 px-3 py-1 text-xs font-medium disabled:opacity-40">Un-suspend</button>
                        : <button disabled={busy || o.isSelf} onClick={() => suspend(o)} title={o.isSelf ? 'You cannot suspend yourself' : 'Suspend this operator'} className="rounded-lg border border-red-800 text-red-200 hover:bg-red-900/40 px-3 py-1 text-xs font-medium disabled:opacity-30">Suspend</button>}
                      {o.twoFactorEnabled && <button disabled={busy} onClick={() => reset2fa(o)} title="Reset 2FA (lost-device recovery)" className="rounded-lg border border-amber-700 text-amber-200 hover:bg-amber-900/40 px-3 py-1 text-xs font-medium disabled:opacity-40">Reset&nbsp;2FA</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">No delete — operators are suspended, never removed, so the audit trail of what they did survives. Suspending the last active owner is refused.</p>
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
  const twoFA = new Set(
    (await prisma.twoFactorSecret.findMany({ where: { subject_type: 'operator', enabled: true }, select: { subject_id: true } })).map((r: { subject_id: string }) => r.subject_id),
  );
  return {
    props: {
      role: gate.op.role,
      initial: rows.map((o: any) => ({
        id: o.id, email: o.email, name: o.name, role: o.role, regions: o.regions, status: o.status,
        suspendedAt: o.suspended_at ? o.suspended_at.toISOString() : null,
        createdAt: o.created_at.toISOString(), lastLoginAt: o.last_login_at ? o.last_login_at.toISOString() : null,
        pending: o.passwordHash === 'INVITE_PENDING' && !o.invite_token_used_at, isSelf: o.id === gate.op.userId,
        twoFactorEnabled: twoFA.has(o.id),
      })),
    },
  };
};
