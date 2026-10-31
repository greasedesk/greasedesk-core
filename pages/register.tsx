/**
 * File: pages/register.tsx
 * Last edited: 2025-11-12 21:06 Europe/London
 *
 * SaaS Onboarding Step 1: Account Creation (for Garage Owner)
 * On success, redirects to /onboarding/check-email
 *
 * Hardening:
 *  - Dev-only patch of Response.prototype.json so empty/non-JSON bodies never crash.
 *  - Fetch reads text, then safely parses JSON; shows API "where" marker on error.
 *  - Sends Accept: application/json and disables caches to avoid stale intermediaries.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Head from 'next/head';
import SiteChrome from '@/components/marketing/SiteChrome';
import { readGdRef, readGdUtm, sanitiseRef } from '@/lib/consent';
import {
  HEARD_ABOUT_OPTIONS, HEARD_ABOUT_OTHER, HEARD_ABOUT_OTHER_MAX,
  readUtmFromQuery, hasUtm, normaliseHeardAbout, UTM_EMPTY, type UtmParts,
} from '@/lib/signup-source';

/* ─────────────────────  SAFE JSON PATCH (browser + dev only)  ───────────────────── */

declare global {
  interface Window { __gd_json_patched?: boolean }
}

if (
  typeof window !== 'undefined' &&
  process.env.NODE_ENV !== 'production' &&
  !window.__gd_json_patched &&
  typeof Response !== 'undefined'
) {
  try {
    const origJson = Response.prototype.json;
    Response.prototype.json = async function patchedJson(this: Response): Promise<any> {
      try {
        const txt = await this.clone().text();
        if (!txt) return {};
        try { return JSON.parse(txt); } catch { return await origJson.call(this.clone()); }
      } catch {
        try { return await origJson.call(this.clone()); } catch { return {}; }
      }
    };
    window.__gd_json_patched = true;
  } catch {
    // noop — don’t let any patching error affect the page
  }
}

/* ──────────────────────────────────────────────────────────────────────────────── */

export default function RegisterPage() {
  const router = useRouter();

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mobile, setMobile] = useState('');
  const [refCode, setRefCode] = useState('');
  const [refNote, setRefNote] = useState<string | null>(null);
  // OPTIONAL, AND IT STARTS EMPTY — no pre-selected option. A default would make "the first one on
  // the list" the most common answer in our own figures, which is worse than not asking.
  const [heardAbout, setHeardAbout] = useState('');
  const [heardAboutOther, setHeardAboutOther] = useState('');
  const [utm, setUtm] = useState<UtmParts>(UTM_EMPTY);

  /**
   * THE REFERRAL CODE, PREFILLED AND VISIBLE.
   *
   * ?ref= ON THIS PAGE NEEDS NO COOKIE AND NO CONSENT (owner, 2026-10-28). It is read from the URL
   * straight into the field and submitted with the form; nothing is stored, so there is nothing to
   * ask permission for. That matters commercially: gd_ref is gated on functional consent, which is
   * off by default, so an affiliate link whose only mechanism was the cookie would credit nobody
   * for the large majority of visitors. This is the path that works.
   *
   * THE URL BEATS THE COOKIE. First-click-wins governs the COOKIE — an old link does not get
   * overwritten by a newer one while someone browses. But arriving on the signup page itself with
   * a code in the URL is not browsing, it is being handed the form by a particular affiliate, and
   * that is the better evidence of who introduced them. The field is editable either way, which is
   * what makes a typed code beat both.
   */
  useEffect(() => {
    if (!router.isReady) return;
    const fromUrl = sanitiseRef(router.query.ref);
    const prefill = fromUrl || sanitiseRef(readGdRef());
    if (prefill) setRefCode((cur) => cur || prefill);
  }, [router.isReady, router.query.ref]);

  /**
   * THE CAMPAIGN, THE SAME WAY ROUND AS THE REF: the URL beats the cookie.
   *
   * utm_* on the signup page itself describes THIS arrival and needs no cookie and no consent —
   * it is read from the URL and submitted with the form, and nothing is stored to ask about. The
   * cookie (gd_utm, functional consent, first visit wins) is the fallback for the ordinary case:
   * somebody clicked a campaign link a fortnight ago and has come back to sign up today.
   *
   * It is INVISIBLE on the form. The referral field is shown because a person can correct it and a
   * mistyped code costs an affiliate money; a campaign parameter is ours, not theirs, and putting
   * it on screen would invite editing of the one field nobody has an opinion about.
   */
  useEffect(() => {
    if (!router.isReady) return;
    const fromUrl = readUtmFromQuery(router.query as Record<string, unknown>);
    setUtm(hasUtm(fromUrl) ? fromUrl : readGdUtm());
  }, [router.isReady, router.query]);

  /** Advisory only — it never blocks the form. Silent while the field is empty. */
  const checkRefCode = async (code: string) => {
    const clean = sanitiseRef(code);
    if (!clean) { setRefNote(null); return; }
    try {
      const r = await fetch('/api/affiliate/check-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: clean }),
      });
      const j = await r.json();
      setRefNote(j?.ok ? null : (j?.message ?? null));
    } catch {
      setRefNote(null); // a failed check is not a verdict about the code
    }
  };

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string | null>(null); // dev-only helper

  function isValidEmail(v: string) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return; // double-submit guard
    setLoading(true);
    setError(null);
    setDebug(null);

    const nameTrim = name.trim();
    const emailNorm = email.trim().toLowerCase();
    const pass = password;

    if (!nameTrim || !emailNorm || !pass) {
      setError('Please fill in all fields.');
      setLoading(false);
      return;
    }
    if (!isValidEmail(emailNorm)) {
      setError('Please enter a valid email address.');
      setLoading(false);
      return;
    }
    if (pass.length < 8) {
      setError('Password must be at least 8 characters long.');
      setLoading(false);
      return;
    }

    const url = '/api/auth/register-garage';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Cache-Control': 'no-store',
          'Pragma': 'no-cache',
        },
        // THE FIELD IS THE ANSWER. It was prefilled from the URL or the cookie and may have been
        // corrected since; whatever it says now is what this person is telling us.
        // THE ANSWER AND THE CAMPAIGN RIDE ALONG, and both are optional: `heardAbout` is null
        // unless an option was chosen, and the free text is sent only with the option that opens
        // it. The server validates both again against the same list — this side is convenience.
        body: JSON.stringify({
          name: nameTrim, email: emailNorm, password: pass, ref: sanitiseRef(refCode) || null,
          heardAbout: normaliseHeardAbout(heardAbout),
          heardAboutOther: heardAbout === HEARD_ABOUT_OTHER ? heardAboutOther.trim() || null : null,
          // BLANK IS NULL, never ''. An empty string in a nullable column is a third state nobody
          // meant: it reads as "they answered, with nothing".
          mobile: mobile.trim() || null,
          utm,
        }),
      });

      const status = res.status;
      const statusText = res.statusText || '';
      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();

      let payload: any = null;
      // We still try JSON regardless of header because some servers forget to set it.
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }

      if (process.env.NODE_ENV !== 'production' && (!res.ok || !payload?.ok)) {
        setDebug(
          `url=${url}\nstatus=${status} ${statusText}\ncontent-type="${contentType}"\nraw=${raw || '<empty>'}`
        );
        // Also echo in DevTools:
        console.debug('register-garage response:', { url, status, statusText, contentType, raw, payload });
      }

      const okFlag = payload?.ok ?? res.ok;
      const where = payload?.where ? ` [${payload.where}]` : '';
      const msg =
        (payload && (payload.message || payload.error)) ||
        raw ||
        (res.ok ? 'Success' : `Registration failed (HTTP ${status}).`);

      if (!okFlag) {
        throw new Error(`${msg}${where}`);
      }

      // Success: redirect to "Check Your Email"
      router.push(`/onboarding/check-email?email=${encodeURIComponent(emailNorm)}`);
    } catch (err: any) {
      setError(err?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Start your trial - GreaseDesk</title>
      </Head>
      <SiteChrome>
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
        <div className="bg-surface border border-line rounded-2xl shadow-card p-8">
          <h1 className="text-xl font-semibold text-ink mb-6 text-center">
            Start your trial
          </h1>

        {/* Error Message */}
        {error && (
          <div className="bg-danger-soft border border-danger text-danger p-3 rounded-lg text-center mb-4">
            <p className="font-semibold">Registration Failed</p>
            <p className="text-sm">{error}</p>
            {process.env.NODE_ENV !== 'production' && debug && (
              <pre className="mt-2 text-[11px] text-danger/80 whitespace-pre-wrap break-all opacity-80">
{debug}
              </pre>
            )}
          </div>
        )}

        {/* Signup Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted mb-1">Full name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-1">Password (min. 8 characters)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {/* ── OPTIONAL, AND SAID SO TWICE: in the label and in the reason. A number asked for
              without a reason reads as a marketing capture and gets a fake one typed into it. ── */}
          <div>
            <label htmlFor="mobile" className="block text-sm font-medium text-muted mb-1">
              Mobile <span className="font-normal">(optional)</span>
            </label>
            <input
              id="mobile"
              data-testid="signup-mobile"
              type="tel"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              autoComplete="tel"
              inputMode="tel"
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <p className="mt-1 text-xs text-muted" data-testid="signup-mobile-why">
              So we can help you get set up.
            </p>
          </div>

          <div>
            <label htmlFor="ref-code" className="block text-sm font-medium text-muted mb-1">
              Referral code <span className="font-normal">(optional)</span>
            </label>
            <input
              id="ref-code"
              data-testid="ref-code"
              type="text"
              value={refCode}
              onChange={(e) => { setRefCode(e.target.value); setRefNote(null); }}
              onBlur={(e) => checkRefCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {refNote && (
              <p data-testid="ref-note" className="mt-1 text-xs text-warn">{refNote}</p>
            )}
          </div>

          <div>
            <label htmlFor="heard-about" className="block text-sm font-medium text-muted mb-1">
              How did you hear about us? <span className="font-normal">(optional)</span>
            </label>
            <select
              id="heard-about"
              data-testid="heard-about"
              value={heardAbout}
              onChange={(e) => setHeardAbout(e.target.value)}
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {/* The empty option is the DEFAULT and says so, so a skipped question reads as
                  skipped rather than as the first answer on the list. */}
              <option value="">Prefer not to say</option>
              {HEARD_ABOUT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {heardAbout === HEARD_ABOUT_OTHER && (
              <input
                id="heard-about-other"
                data-testid="heard-about-other"
                type="text"
                value={heardAboutOther}
                onChange={(e) => setHeardAboutOther(e.target.value)}
                maxLength={HEARD_ABOUT_OTHER_MAX}
                placeholder="Where did you hear about us?"
                autoComplete="off"
                className="mt-2 w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent"
              />
            )}
          </div>

          <p className="text-xs text-muted text-center leading-relaxed">
            By creating an account you accept our{' '}
            <Link href="/terms" className="text-accent hover:underline">Terms of Service</Link> and{' '}
            <Link href="/privacy" className="text-accent hover:underline">Privacy Policy</Link>.
          </p>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent text-white font-medium rounded-xl px-4 py-2 disabled:opacity-50"
          >
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <div className="text-center mt-6">
          <Link href="/admin/login" className="text-sm text-muted hover:text-accent">
            Already have an account? Sign In
          </Link>
        </div>
        </div>
      </div>
      </SiteChrome>
    </>
  );
}
