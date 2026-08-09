/**
 * File: components/settings/PhoneVerifyPanel.tsx
 * Capture and confirm the signed-in user's own mobile. ONE component, two homes: the signup step at
 * /onboarding/phone and Settings → your account. Both drive /api/account/phone, so the rules, the
 * cooldown and the wording cannot drift between "at signup" and "later".
 *
 * ── IT IS NOW MANDATORY AT SIGNUP, SO EVERY DEAD END IS A LOCKOUT ───────────────────────────────
 * There is no "I'll do this later" any more (ruling 2026-08-09). That raises the stakes on every
 * failure path: a step somebody cannot finish is a customer who cannot reach the product they are
 * about to pay for. So each state offers a real action — resend, change the number, switch to email,
 * and a phone number that reaches a person who can exempt the account.
 *
 * ── TWO CHANNELS, TWO DIFFERENT CLAIMS ──────────────────────────────────────────────────────────
 * An SMS code proves a HANDSET. An emailed code proves the account inbox and merely records the
 * number. Both satisfy the signup gate; only the first sets phone_verified_at, which is what SMS
 * 2FA is later built on. The wording says which happened rather than flattening them.
 *
 * The cooldown COUNTS DOWN ON SCREEN rather than letting the resend button fail silently — "nothing
 * happened when I pressed it" is how people conclude the product is broken.
 */
import React from 'react';

type State = {
  phone: string | null; verified: boolean; recorded: boolean; confirmedVia: string | null;
  codeOutstanding: boolean; pendingPhone: string | null; pendingDiffers: boolean;
  smsAvailable: boolean; emailAvailable: boolean; supportPhone: string;
};

const input = 'w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink focus:ring-2 focus:ring-accent focus:outline-none';
const primary = 'bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50';
const linkish = 'text-sm text-muted hover:text-ink underline underline-offset-2';
const secondary = 'bg-surface-muted border border-line text-ink font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50';

export default function PhoneVerifyPanel({ onDone, heading }: {
  onDone?: () => void;
  /** NULL suppresses the panel's own title — for the wizard, where the layout already renders one
   *  and two stacked headings is just noise. */
  heading?: string | null;
}) {
  const [state, setState] = React.useState<State | null>(null);
  const [phone, setPhone] = React.useState('');
  const [code, setCode] = React.useState('');
  const [stage, setStage] = React.useState<'enter' | 'confirm'>('enter');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  // Told to us by the send response — never a literal here. The server owns the code's life, so the
  // screen must not carry its own copy of the number.
  const [expiresInMinutes, setExpiresInMinutes] = React.useState<number | null>(null);
  const [sentVia, setSentVia] = React.useState<'sms' | 'email'>('sms');
  const [sentToEmail, setSentToEmail] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(0);
  // Revealing the entry field on a verified account is a LOCAL intent, never a claim about the
  // server's state — the confirmed number stays confirmed until a new one is proven.
  const [changing, setChanging] = React.useState(false);

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

  const send = async (channel?: 'sms' | 'email') => {
    const d = await post({ action: 'send', phone, ...(channel ? { channel } : {}) });
    if (d) {
      setSentTo(d.phone); setExpiresInMinutes(d.expiresInMinutes ?? null);
      setSentVia(d.channel ?? 'sms'); setSentToEmail(d.sentToEmail ?? null);
      setStage('confirm'); setCode(''); setCooldown(60);
    }
  };
  const confirm = async () => {
    const d = await post({ action: 'confirm', code }); // channel is the SERVER's to know
    if (d) { setOk(d.message); setStage('enter'); setChanging(false); setCode(''); await refresh(); onDone?.(); }
  };

  if (!state) return null;

  /** EVERY DEAD END GETS A ROUTE OUT. The step is mandatory, so "it isn't working" must never be
   *  the end of the conversation — a real number reaches a person who can exempt the account. */
  const help = (
    <p className="mt-3 text-xs text-muted" data-testid="phone-help">
      Having trouble? Call us on{' '}
      <a className="text-accent font-semibold" href={`tel:${(state?.supportPhone ?? '').replace(/\s/g, '')}`}>{state?.supportPhone}</a>
      {' '}and we’ll sort it out with you.
    </p>
  );

  // ── SETTLED: EITHER CHANNEL SATISFIED THE GATE ───────────────────────────────────────────────
  // `changing` is local state, NOT a fake unverified server state. The previous version flipped
  // `state.verified` to false to reveal the entry field, which meant the screen claimed the account
  // was unverified while the server still (correctly) had it confirmed — and left no way back.
  //
  // RECORDED-BUT-NOT-VERIFIED IS ITS OWN BRANCH, not a variant of "unconfirmed". An emailed code
  // clears the gate, so leaving this case in the entry state would leave someone who has finished
  // the step staring at a form with no Continue button — mandatory step, no way forward, which is
  // exactly the lockout the whole design is trying not to build.
  if ((state.verified || state.recorded) && stage === 'enter' && !changing) {
    const byEmail = !state.verified;
    return (
      <div data-testid="phone-panel">
        {heading !== null && <h2 className="text-lg font-semibold text-ink mb-1">{heading ?? 'Mobile number'}</h2>}
        {byEmail ? (
          <p className="text-sm text-ink" data-testid="phone-recorded">
            <span className="font-mono">{state.phone}</span> <span className="text-warn">Recorded</span>
            {/* SAYS WHAT WE ACTUALLY KNOW. We proved the account's inbox, not the handset — and the
                difference matters the day this number is asked to carry a login code. */}
            <span className="block text-muted mt-0.5">
              You confirmed this by email, so it’s saved against your account but we haven’t yet
              proved the handset. Send yourself a text whenever you like to finish that off.
            </span>
          </p>
        ) : (
          <p className="text-sm text-ink" data-testid="phone-verified">
            <span className="font-mono">{state.phone}</span> <span className="text-ok">✓ Confirmed</span>
          </p>
        )}
        <div className="flex flex-wrap gap-2 items-center mt-3">
          <button type="button" className={secondary} onClick={() => { setChanging(true); setPhone(''); setSentTo(null); setOk(null); setErr(null); }}>
            {byEmail ? 'Confirm by text' : 'Change number'}
          </button>
          {/* THE WAY FORWARD. Without it this branch was a dead end — fine as a settings panel,
              impossible as a step, and the step is where it now matters. */}
          {onDone && <button type="button" className={primary} onClick={onDone} data-testid="phone-continue">Continue</button>}
        </div>
        {ok && <p className="mt-2 text-sm text-ok" data-testid="phone-ok">{ok}</p>}
      </div>
    );
  }

  return (
    <div data-testid="phone-panel">
      {heading !== null && <h2 className="text-lg font-semibold text-ink mb-1">{heading ?? 'Add your mobile number'}</h2>}

      {/* ── SAID BEFORE ANYONE TYPES ────────────────────────────────────────────────────────────
          Discovering the only channel is down AFTER filling in a number and pressing send wastes
          the one moment somebody was willing to spend on this. If texts are off we say so, and we
          say what happens instead — the code comes by email and the step still completes. */}
      {!state.smsAvailable && stage === 'enter' && (
        <p className="text-sm text-warn bg-warn-soft border border-warn rounded-lg p-3 mb-3" data-testid="phone-sms-down">
          {state.emailAvailable
            ? 'Text messages are unavailable at the moment, so we’ll email your code instead. Enter your mobile number as normal — we still record it against your account.'
            : `We can’t send a code right now. Call us on ${state.supportPhone} and we’ll get you set up.`}
        </p>
      )}

      {stage === 'enter' ? (
        <>
          {state.verified && changing ? (
            <p className="text-sm text-muted mb-3" data-testid="phone-changing">
              Your confirmed number is <span className="font-mono text-ink">{state.phone}</span>. It stays
              confirmed until a new one is confirmed — nothing changes if you stop here.
              {' '}<button type="button" onClick={() => setChanging(false)} className={linkish}>Keep it</button>
            </p>
          ) : state.phone && !state.verified ? (
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
            <button type="button" disabled={busy || !phone.trim() || (!state.smsAvailable && !state.emailAvailable)} onClick={() => send()} className={primary} data-testid="phone-send">
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
          </div>
          {help}
        </>
      ) : (
        <>
          <p className="text-sm text-ink mb-1">Enter the 6-digit code</p>
          <p className="text-sm text-muted mb-3">
            {sentVia === 'email'
              ? <>We’ve emailed your code to <span className="font-mono text-ink">{sentToEmail}</span> — texts aren’t getting through, so we’ve used your account email.</>
              : <>We’ve sent a code to <span className="font-mono text-ink">{sentTo}</span>.</>}
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
            <button type="button" disabled={busy || cooldown > 0} onClick={() => send()}
              className={`${linkish} disabled:opacity-50 disabled:no-underline`} data-testid="phone-resend">
              Send another code
            </button>
            {cooldown > 0 && <span className="text-muted"> (available in {cooldown}s)</span>}
            {' · '}
            <button type="button" onClick={() => { setStage('enter'); setCode(''); setErr(null); }} className={linkish} data-testid="phone-change">
              Change the number
            </button>
            {/* THE FALLBACK, offered rather than hidden. A text that has not arrived twice is not
                going to arrive; the email route completes the step and records the number. */}
            {sentVia === 'sms' && state.emailAvailable && (
              <> · <button type="button" disabled={busy} onClick={() => send('email')} className={linkish} data-testid="phone-email-instead">
                Email me the code instead
              </button></>
            )}
          </p>
          {help}
        </>
      )}

      {err && <p className="mt-3 text-sm text-danger" data-testid="phone-error">{err}</p>}
      {ok && <p className="mt-3 text-sm text-ok" data-testid="phone-ok">{ok}</p>}
    </div>
  );
}
