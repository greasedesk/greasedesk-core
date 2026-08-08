/**
 * File: components/settings/TwoFactorPanel.tsx
 * The tenant two-factor panel on Settings → Users → (your own account). SELF ONLY — it is never
 * rendered on someone else's record, because there is nothing here an admin could legitimately do
 * to a colleague. Their one power is Reset, which lives on the roster and only ever DISABLES.
 *
 * Drives the full lifecycle over /api/account/2fa: enrol (QR + key) → confirm a live code (ONLY then
 * is 2FA enabled) → recovery codes shown once → later disable (password + a code). Every rule is the
 * server's; this is the surface. The tenant twin of components/engine-room/TwoFactorCard, written
 * separately because the workspace palette and the Engine Room's slate one share no tokens.
 *
 * TWO PIECES OF COPY ARE LOAD-BEARING and must not be trimmed:
 *   • "Nothing changes until you enter a working code" — the interface stating the chokepoint's rule,
 *     so someone who closes the tab midway knows their account is unchanged rather than half-locked.
 *   • "not on the phone that has the authenticator on it" — recovery codes stored beside the
 *     authenticator protect nobody. This line is what prevents the 7am lockout call.
 */
import React from 'react';

type Status = { enabled: boolean; pending: boolean; recoveryRemaining: number };

const card = 'bg-surface border border-line rounded-2xl p-5 mb-6';
const input = 'w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink focus:ring-2 focus:ring-accent focus:outline-none';
const primary = 'bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50';
const secondary = 'bg-surface-muted border border-line text-ink font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50';

export default function TwoFactorPanel() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const [enrol, setEnrol] = React.useState<{ secret: string; qrDataUri: string } | null>(null);
  const [code, setCode] = React.useState('');
  const [recovery, setRecovery] = React.useState<string[] | null>(null);
  const [ack, setAck] = React.useState(false); // the explicit acknowledgement — gates Finish

  const [showDisable, setShowDisable] = React.useState(false);
  const [disPw, setDisPw] = React.useState('');
  const [disCode, setDisCode] = React.useState('');

  const refresh = React.useCallback(async () => {
    const r = await fetch('/api/account/2fa');
    if (r.ok) setStatus(await r.json());
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/account/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d?.message || 'Something went wrong.' }); return null; }
      return d;
    } catch { setMsg({ ok: false, text: 'Something went wrong.' }); return null; }
    finally { setBusy(false); } // never strand the busy flag
  }

  const start = async () => {
    const d = await post({ action: 'enrol' });
    if (d) { setEnrol({ secret: d.secret, qrDataUri: d.qrDataUri }); setCode(''); }
  };
  const confirm = async () => {
    const d = await post({ action: 'confirm', code });
    if (d) { setRecovery(d.recoveryCodes); setAck(false); setEnrol(null); setCode(''); await refresh(); }
  };
  const turnOff = async () => {
    const d = await post({ action: 'disable', password: disPw, code: disCode });
    if (d) { setShowDisable(false); setDisPw(''); setDisCode(''); setMsg({ ok: true, text: d.message }); await refresh(); }
  };

  if (!status) return null;

  // RECOVERY CODES take over the panel until acknowledged — they are shown once, and a user who
  // scrolls past them has lost them. Nothing else is actionable while they are on screen.
  if (recovery) {
    return (
      <div className={card} data-testid="twofactor-recovery">
        <h2 className="text-lg font-semibold text-ink mb-1">Save your recovery codes now</h2>
        <p className="text-sm text-muted mb-3">
          These are shown once and never again. Each one signs you in a single time if you lose your phone.
          Print them, or put them in your password manager — not on the phone that has the authenticator on it.
        </p>
        <div className="grid grid-cols-2 gap-1 font-mono text-sm text-ink bg-surface-muted border border-line rounded-lg p-3">
          {recovery.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <button type="button" className={secondary}
            onClick={() => { navigator.clipboard?.writeText(recovery.join('\n')); setMsg({ ok: true, text: 'Recovery codes copied.' }); }}>Copy all</button>
          <button type="button" className={secondary}
            onClick={() => {
              const blob = new Blob([recovery.join('\n') + '\n'], { type: 'text/plain' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob); a.download = 'greasedesk-recovery-codes.txt'; a.click();
              URL.revokeObjectURL(a.href);
            }}>Download</button>
        </div>
        <label className="flex items-center gap-2 mt-4 text-sm text-ink">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="recovery-ack" />
          I’ve saved these codes somewhere safe
        </label>
        <button type="button" disabled={!ack} onClick={() => { setRecovery(null); setMsg(null); }}
          className={`${primary} mt-3`} data-testid="recovery-finish">Finish</button>
        {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>}
      </div>
    );
  }

  return (
    <div className={card} data-testid="twofactor-panel">
      <h2 className="text-lg font-semibold text-ink mb-1">Two-factor authentication</h2>

      {status.enabled ? (
        <>
          <p className="text-sm text-ink mb-1" data-testid="twofactor-on">🔒 Two-factor authentication is on</p>
          <p className="text-sm text-muted">You’ll be asked for a code from your authenticator app each time you sign in.</p>
          <p className="text-xs text-muted mt-1">{status.recoveryRemaining} of 10 recovery codes remaining.</p>
          {!showDisable
            ? <button type="button" className={`${secondary} mt-3`} onClick={() => setShowDisable(true)}>Turn off</button>
            : (
              <div className="mt-3 border-t border-line pt-3 space-y-2">
                <p className="text-sm text-muted">
                  Turning this off leaves your account protected by your password alone.
                  Enter your password and a current code to confirm.
                </p>
                <input type="password" className={input} placeholder="Your password" value={disPw} onChange={(e) => setDisPw(e.target.value)} />
                <input type="text" inputMode="numeric" autoComplete="one-time-code" className={input}
                  placeholder="Authenticator or recovery code" value={disCode} onChange={(e) => setDisCode(e.target.value)} />
                <div className="flex gap-2">
                  <button type="button" disabled={busy} className={secondary} onClick={turnOff}>{busy ? 'Turning off…' : 'Turn off'}</button>
                  <button type="button" className="text-sm text-muted px-2" onClick={() => setShowDisable(false)}>Cancel</button>
                </div>
              </div>
            )}
        </>
      ) : enrol ? (
        <>
          <p className="text-sm font-medium text-ink mb-1">Scan this with your authenticator app</p>
          <p className="text-sm text-muted mb-3">
            Open your authenticator app and scan the code. If you can’t scan it, enter this key by hand:{' '}
            <span className="font-mono text-ink break-all">{enrol.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrol.qrDataUri} alt="Two-factor QR code" className="border border-line rounded-lg bg-white p-1" width={220} height={220} />
          <p className="text-sm text-muted mt-3 mb-1">Then type the 6-digit code the app shows.</p>
          <div className="flex flex-wrap gap-2 items-center">
            <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              className={`${input} max-w-[10rem]`} placeholder="6-digit code" value={code}
              onChange={(e) => setCode(e.target.value)} data-testid="enrol-code" />
            <button type="button" disabled={busy || code.trim().length < 6} className={primary} onClick={confirm} data-testid="enrol-confirm">
              {busy ? 'Checking…' : 'Confirm and turn on'}
            </button>
            <button type="button" className="text-sm text-muted px-2" onClick={() => { setEnrol(null); setCode(''); setMsg(null); }}>Cancel</button>
          </div>
          <p className="text-xs text-muted mt-2">
            Nothing changes until you enter a working code — if you close this now, two-factor authentication stays off.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink mb-1">Off. Your password alone signs you in.</p>
          <p className="text-sm text-muted mb-3">
            Add a second step at sign-in using a free authenticator app on your phone — Google Authenticator,
            Microsoft Authenticator, 1Password or similar. It takes about a minute.
          </p>
          <button type="button" disabled={busy} className={primary} onClick={start} data-testid="twofactor-start">
            {busy ? 'Starting…' : 'Turn on two-factor authentication'}
          </button>
        </>
      )}

      {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`} data-testid="twofactor-msg">{msg.text}</p>}
    </div>
  );
}
