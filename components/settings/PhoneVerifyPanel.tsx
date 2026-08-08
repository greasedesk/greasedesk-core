/**
 * File: components/settings/PhoneVerifyPanel.tsx
 * Capture and confirm the signed-in user's own mobile. ONE component, two homes: the signup step at
 * /onboarding/phone and Settings → your account. Both drive /api/account/phone, so the rules, the
 * cooldown and the wording cannot drift between "at signup" and "later".
 *
 * ── NOTHING HERE BLOCKS ANYTHING ────────────────────────────────────────────────────────────────
 * Every state offers a way out, and "I'll do this later" is a plain link at the same visual weight
 * as the button — not greyed, not buried. Continuing without a number is a legitimate choice, and a
 * flow that only looks skippable is worse than one that is honestly optional. `onSkip` is what makes
 * the signup step non-blocking; the settings copy simply omits it.
 *
 * The cooldown COUNTS DOWN ON SCREEN rather than letting the resend button fail silently — "nothing
 * happened when I pressed it" is how people conclude the product is broken.
 */
import React from 'react';

type State = { phone: string | null; verified: boolean; codeOutstanding: boolean };

const input = 'w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink focus:ring-2 focus:ring-accent focus:outline-none';
const primary = 'bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50';
const linkish = 'text-sm text-muted hover:text-ink underline underline-offset-2';

export default function PhoneVerifyPanel({ onSkip, onDone, heading }: {
  /** Present ONLY at signup. Its absence is what makes the settings copy read as ongoing rather than
   *  a step to get past. */
  onSkip?: () => void;
  onDone?: () => void;
  heading?: string;
}) {
  const [state, setState] = React.useState<State | null>(null);
  const [phone, setPhone] = React.useState('');
  const [code, setCode] = React.useState('');
  const [stage, setStage] = React.useState<'enter' | 'confirm'>('enter');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  // Told to us by the send response — never a literal here. The server owns the code's life, so the
  // screen must not carry its own copy of the number.
  const [expiresInMinutes, setExpiresInMinutes] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(0);

  const refresh = React.useCallback(async () => {
    const r = await fetch('/api/account/phone');
    if (r.ok) setState(await r.json());
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  // The visible countdown. Cleared on unmount so a fast navigation doesn't leave a timer running.
  React.useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function post(body: Record<string, unknown>) {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fetch('/api/account/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d?.message || 'Something went wrong.');
        if (typeof d?.retryAfterSeconds === 'number') setCooldown(d.retryAfterSeconds);
        return null;
      }
      return d;
    } catch { setErr('Something went wrong.'); return null; }
    finally { setBusy(false); } // never strand the busy flag
  }

  const send = async () => {
    const d = await post({ action: 'send', phone });
    if (d) { setSentTo(d.phone); setExpiresInMinutes(d.expiresInMinutes ?? null); setStage('confirm'); setCode(''); setCooldown(60); }
  };
  const confirm = async () => {
    const d = await post({ action: 'confirm', code });
    if (d) { setOk(d.message); setStage('enter'); setCode(''); await refresh(); onDone?.(); }
  };

  if (!state) return null;

  const skip = onSkip && (
    <button type="button" onClick={onSkip} className={linkish} data-testid="phone-later">I’ll do this later</button>
  );

  // ── ALREADY CONFIRMED ────────────────────────────────────────────────────────────────────────
  if (state.verified && stage === 'enter') {
    return (
      <div data-testid="phone-panel">
        <h2 className="text-lg font-semibold text-ink mb-1">{heading ?? 'Mobile number'}</h2>
        <p className="text-sm text-ink" data-testid="phone-verified">
          <span className="font-mono">{state.phone}</span> <span className="text-ok">✓ Confirmed</span>
        </p>
        <button type="button" className={`${primary} mt-3`} onClick={() => { setStage('enter'); setPhone(''); setSentTo(null); setState({ ...state, verified: false }); }}>
          Change number
        </button>
        {ok && <p className="mt-2 text-sm text-ok" data-testid="phone-ok">{ok}</p>}
      </div>
    );
  }

  return (
    <div data-testid="phone-panel">
      <h2 className="text-lg font-semibold text-ink mb-1">{heading ?? 'Add your mobile number'}</h2>

      {stage === 'enter' ? (
        <>
          {state.phone && !state.verified ? (
            <p className="text-sm text-ink mb-2" data-testid="phone-unverified">
              <span className="font-mono">{state.phone}</span> — <span className="text-warn font-medium">not confirmed</span>
              <span className="block text-muted mt-0.5">Confirm it so we can reach you if you’re ever locked out.</span>
            </p>
          ) : (
            <p className="text-sm text-muted mb-3">
              We’ll use it to confirm it’s you if you ever get locked out, and for the odd urgent message
              about your account. We won’t use it for marketing, and we’ll never pass it on.
            </p>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <input type="tel" inputMode="tel" autoComplete="tel" placeholder="07700 900123" value={phone}
              onChange={(e) => setPhone(e.target.value)} className={`${input} max-w-[14rem]`} data-testid="phone-input" />
            <button type="button" disabled={busy || !phone.trim()} onClick={send} className={primary} data-testid="phone-send">
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
            {skip}
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-ink mb-1">Enter the 6-digit code</p>
          <p className="text-sm text-muted mb-3">
            We’ve sent a code to <span className="font-mono text-ink">{sentTo}</span>.
            {expiresInMinutes ? ` It expires in ${expiresInMinutes} minutes.` : ''}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code"
              value={code} onChange={(e) => setCode(e.target.value)} className={`${input} max-w-[10rem]`} data-testid="phone-code" />
            <button type="button" disabled={busy || code.trim().length < 6} onClick={confirm} className={primary} data-testid="phone-confirm">
              {busy ? 'Checking…' : 'Confirm'}
            </button>
          </div>
          <p className="mt-3 text-sm text-muted">
            Didn’t arrive?{' '}
            <button type="button" disabled={busy || cooldown > 0} onClick={send}
              className={`${linkish} disabled:opacity-50 disabled:no-underline`} data-testid="phone-resend">
              Send another code
            </button>
            {cooldown > 0 && <span className="text-muted"> (available in {cooldown}s)</span>}
            {' · '}
            <button type="button" onClick={() => { setStage('enter'); setCode(''); setErr(null); }} className={linkish} data-testid="phone-change">
              Change the number
            </button>
            {skip && <> · {skip}</>}
          </p>
        </>
      )}

      {err && <p className="mt-3 text-sm text-danger" data-testid="phone-error">{err}</p>}
      {ok && <p className="mt-3 text-sm text-ok" data-testid="phone-ok">{ok}</p>}
    </div>
  );
}
