/**
 * File: pages/superadmin/settings.tsx
 * The operator's OWN account — all roles. Change your name, email (current password required, notifies
 * the old address), and password (current password required). Everything here acts on the LOGGED-IN
 * operator's own record via /api/superadmin/operator-account; role/region/suspend are owner-only and
 * live on the Operators screen, not here.
 */
import { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Props = { role: OperatorRoleName; email: string; name: string };
const input = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';
const btn = 'bg-slate-100 text-slate-900 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="text-sm font-semibold mb-3">{title}</h2>{children}</div>;
}

export default function OperatorSettings({ role, email, name }: Props) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nm, setNm] = useState(name);
  const [em, setEm] = useState(email); const [emPw, setEmPw] = useState('');
  const [curPw, setCurPw] = useState(''); const [newPw, setNewPw] = useState(''); const [confPw, setConfPw] = useState('');

  async function call(body: any): Promise<boolean> {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/superadmin/operator-account', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false); setMsg({ ok: r.ok, text: d.message || (r.ok ? 'Done.' : 'Failed.') });
    return r.ok;
  }

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — settings</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-2xl space-y-5">
        <h1 className="text-xl font-semibold">Your account</h1>
        {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}

        <Card title="Name">
          <form onSubmit={async (e) => { e.preventDefault(); await call({ action: 'name', name: nm }); }} className="flex gap-2 items-end">
            <div className="flex-1"><label className="block text-xs text-slate-400 mb-1">Display name</label><input value={nm} onChange={(e) => setNm(e.target.value)} required className={input} /></div>
            <button className={btn} disabled={busy}>Save</button>
          </form>
        </Card>

        <Card title="Email">
          <form onSubmit={async (e) => { e.preventDefault(); if (await call({ action: 'email', email: em, currentPassword: emPw })) setEmPw(''); }} className="space-y-2">
            <div><label className="block text-xs text-slate-400 mb-1">Email</label><input type="email" value={em} onChange={(e) => setEm(e.target.value)} required className={input} /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Current password (to confirm)</label><input type="password" autoComplete="current-password" value={emPw} onChange={(e) => setEmPw(e.target.value)} required className={input} /></div>
            <button className={btn} disabled={busy}>Change email</button>
            <p className="text-[11px] text-slate-500">The old address is notified. (Full new-address confirmation isn't built yet.)</p>
          </form>
        </Card>

        <Card title="Password">
          <form onSubmit={async (e) => { e.preventDefault(); if (await call({ action: 'password', currentPassword: curPw, newPassword: newPw, confirmPassword: confPw })) { setCurPw(''); setNewPw(''); setConfPw(''); } }} className="space-y-2">
            <div><label className="block text-xs text-slate-400 mb-1">Current password</label><input type="password" autoComplete="current-password" value={curPw} onChange={(e) => setCurPw(e.target.value)} required className={input} /></div>
            <div><label className="block text-xs text-slate-400 mb-1">New password</label><input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required minLength={8} className={input} /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Confirm new password</label><input type="password" autoComplete="new-password" value={confPw} onChange={(e) => setConfPw(e.target.value)} required minLength={8} className={input} /></div>
            <button className={btn} disabled={busy}>Change password</button>
          </form>
        </Card>
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireOperatorPage(ctx); // any operator
  if (!gate.ok) return { notFound: true };
  const { prisma } = await import('@/lib/db');
  const op = await prisma.operator.findUnique({ where: { id: gate.op.userId }, select: { email: true, name: true } });
  return { props: { role: gate.op.role, email: op?.email ?? '', name: op?.name ?? '' } };
};
