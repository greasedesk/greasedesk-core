/**
 * File: components/engine-room/TwoFactorCard.tsx
 * The Engine Room Settings two-factor panel (self). Drives the full TOTP lifecycle over
 * /api/superadmin/2fa: enrol (QR + secret) → confirm a code (only then is 2FA enabled) → recovery
 * codes shown once → later disable (password + a code). Server owns every rule; this is the surface.
 */
import { useCallback, useEffect, useState } from 'react';

type Status = { enabled: boolean; pending: boolean; recoveryRemaining: number };
const input = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';
const btn = 'bg-slate-100 text-slate-900 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';

export default function TwoFactorCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // enrolment
  const [enrol, setEnrol] = useState<{ secret: string; qrDataUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  // disable
  const [showDisable, setShowDisable] = useState(false);
  const [disPw, setDisPw] = useState(''); const [disCode, setDisCode] = useState('');

  const refresh = useCallback(async () => {
    const r = await fetch('/api/superadmin/2fa');
    if (r.ok) setStatus(await r.json());
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function post(body: any): Promise<any> {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/superadmin/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: d.message || 'Failed.' }); return null; }
    return d;
  }

  async function startEnrol() {
    const d = await post({ action: 'enrol' });
    if (d) { setEnrol({ secret: d.secret, qrDataUri: d.qrDataUri }); setRecovery(null); setCode(''); }
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    const d = await post({ action: 'confirm', code });
    if (d) { setRecovery(d.recoveryCodes); setEnrol(null); setCode(''); setMsg({ ok: true, text: d.message }); await refresh(); }
  }
  async function disable(e: React.FormEvent) {
    e.preventDefault();
    const d = await post({ action: 'disable', password: disPw, code: disCode });
    if (d) { setShowDisable(false); setDisPw(''); setDisCode(''); setMsg({ ok: true, text: d.message }); await refresh(); }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-semibold mb-1">Two-factor authentication</h2>
      <p className="text-xs text-slate-400 mb-3">An authenticator app (Google Authenticator, 1Password, Authy…) generates a 6-digit code you enter after your password. This is the platform master key — protect it.</p>
      {msg && <div className={`mb-3 text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}

      {/* Recovery codes — shown once, right after enrolment */}
      {recovery && (
        <div className="mb-3 rounded-lg border border-amber-800 bg-amber-950/40 p-4">
          <div className="text-sm text-amber-200 mb-2 font-medium">Save these recovery codes now — shown only once.</div>
          <div className="grid grid-cols-2 gap-1 font-mono text-sm text-amber-100">{recovery.map((c) => <span key={c}>{c}</span>)}</div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => { navigator.clipboard?.writeText(recovery.join('\n')); setMsg({ ok: true, text: 'Recovery codes copied.' }); }} className="rounded-lg border border-amber-700 text-amber-100 px-3 py-1 text-xs">Copy all</button>
            <button onClick={() => setRecovery(null)} className="text-amber-300/70 text-xs px-2">I’ve saved them</button>
          </div>
          <div className="text-[11px] text-amber-300/70 mt-2">Each code works once, as a substitute for the app if you lose your phone.</div>
        </div>
      )}

      {status == null ? <div className="text-slate-500 text-sm">Loading…</div>
        : status.enabled ? (
          <div>
            <div className="text-sm text-emerald-300 mb-1">● 2FA is on.</div>
            <div className="text-xs text-slate-400 mb-3">{status.recoveryRemaining} recovery code{status.recoveryRemaining === 1 ? '' : 's'} remaining.</div>
            {!showDisable ? (
              <button onClick={() => setShowDisable(true)} className="rounded-lg border border-red-800 text-red-200 hover:bg-red-900/40 px-3 py-1.5 text-xs font-medium">Disable 2FA</button>
            ) : (
              <form onSubmit={disable} className="space-y-2 max-w-xs">
                <div><label className="block text-xs text-slate-400 mb-1">Current password</label><input type="password" autoComplete="current-password" value={disPw} onChange={(e) => setDisPw(e.target.value)} required className={input} /></div>
                <div><label className="block text-xs text-slate-400 mb-1">Authenticator or recovery code</label><input type="text" value={disCode} onChange={(e) => setDisCode(e.target.value)} required className={input} /></div>
                <div className="flex gap-2"><button className={btn} disabled={busy}>Confirm disable</button><button type="button" onClick={() => setShowDisable(false)} className="text-slate-400 text-xs px-2">Cancel</button></div>
              </form>
            )}
          </div>
        ) : enrol ? (
          <div>
            <p className="text-sm text-slate-300 mb-2">1. Scan this with your authenticator app:</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrol.qrDataUri} alt="TOTP QR code" width={200} height={200} className="rounded-lg bg-white p-2 mb-2" />
            <p className="text-xs text-slate-400 mb-1">Can’t scan? Enter this secret manually:</p>
            <code className="block bg-slate-800 rounded px-2 py-1 text-xs text-slate-100 font-mono mb-3 break-all">{enrol.secret}</code>
            <form onSubmit={confirm} className="space-y-2 max-w-xs">
              <label className="block text-xs text-slate-400">2. Enter the current 6-digit code to turn it on:</label>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="000000" className={input} />
              <div className="flex gap-2"><button className={btn} disabled={busy}>Confirm & enable</button><button type="button" onClick={() => setEnrol(null)} className="text-slate-400 text-xs px-2">Cancel</button></div>
            </form>
          </div>
        ) : (
          <button onClick={startEnrol} disabled={busy} className={btn}>Set up two-factor authentication</button>
        )}
    </div>
  );
}
