/**
 * File: pages/rep-site/index.tsx
 * THE PUBLIC RESELLER SITE, at the root of reps.greasedesk.com (middleware rewrites '/' here).
 *
 * ── WHO SEES WHAT ───────────────────────────────────────────────────────────────────────────────
 * A visitor with no rep session sees this page. A SIGNED-IN REP IS REDIRECTED TO THE PORTAL, because
 * the root was their front door before this page existed and that must not regress — rep-host-gate
 * holds both halves. The branch is here, in getServerSideProps, and NOT in middleware: lib/rep-auth
 * records why (a JWT decrypt per request to choose a rewrite is a real cost for a decision the page
 * layer already has the answer to).
 *
 * ── COPY IS PLACEHOLDER, DELIBERATELY ───────────────────────────────────────────────────────────
 * The owner writes the real copy. Nothing here invents an earnings figure, a garage count, a
 * testimonial or a partner name — and the one place a number belongs is marked, not guessed.
 * /reseller's own header recorded that decision when the commission model was unsettled, and the
 * owner confirmed it still holds (2026-09-12): the number stays out.
 *
 * Trade framing is primary — the people this is for already drive a round of garages. The open door
 * ("you don't have to be on a van") is ONE secondary line, not a second page.
 *
 * ── MOBILE FIRST ────────────────────────────────────────────────────────────────────────────────
 * Opened from a phone, from a link in a video description. Base classes are the phone; `sm:` and up
 * only ever add. rep-site-mobile-gate drives it at 375px and asserts the page never scrolls sideways.
 */
import { useState } from 'react';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import Seo from '@/components/marketing/Seo';
import RepSiteChrome from '@/components/rep-site/RepSiteChrome';
import Turnstile from '@/components/marketing/Turnstile';
import { COMPANY, REP_SITE_URL, absoluteRepSiteUrl } from '@/lib/company-info';
import { LIMITS } from '@/lib/reseller-interest';

const input = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-base focus:ring-2 focus:ring-accent focus:border-accent outline-none';

const Check = () => (
  <svg className="w-5 h-5 text-accent shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

/** PLACEHOLDER — the owner's words go here. Marked so nothing reads as a finished claim. */
const PLACEHOLDER = {
  hero: 'Introduce GreaseDesk to the garages you already visit.',
  sub: 'PLACEHOLDER — the owner writes this paragraph. Trade framing: you already have the round and the relationships; this is a product you can introduce and earn from alongside what you already do.',
  earnings: 'PLACEHOLDER — what a reseller earns goes here. No figure is published yet.',
  openDoor: 'PLACEHOLDER — the secondary line: you don’t have to be on a van to do this.',
  how: [
    'PLACEHOLDER — step one.',
    'PLACEHOLDER — step two.',
    'PLACEHOLDER — step three.',
  ],
  suits: [
    'Tool-van reps with an established round',
    'Motor factor reps and delivery drivers',
    'Equipment and calibration engineers — MOT kit, ramps, diagnostics',
    'Oil, consumables and workwear reps',
    'Retired garage owners and trade consultants',
  ],
};

export default function ResellerSite() {
  const [form, setForm] = useState({ name: '', company: '', area: '', email: '', phone: '', message: '', website: '' });
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending'); setMsg(null);
    try {
      const res = await fetch('/api/rep-site/interest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, turnstileToken: token }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setState('sent'); setMsg(data.message || 'Thanks — we’ll be in touch.');
        setForm({ name: '', company: '', area: '', email: '', phone: '', message: '', website: '' });
      } else { setState('error'); setMsg(data?.message || 'Something went wrong. Please try again.'); }
    } catch {
      setState('error'); setMsg('We couldn’t reach the server. Please try again shortly.');
    }
  }

  return (
    <>
      <Seo
        title="Become a GreaseDesk reseller"
        description="Already visiting independent garages every week? Introduce GreaseDesk and earn from it. Register your interest."
        path="/"
        origin={REP_SITE_URL}
        ogImage={absoluteRepSiteUrl('/rep-site/og.png')}
      />
      <RepSiteChrome>
        <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-10 sm:pt-16 pb-12">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-ink tracking-tight">{PLACEHOLDER.hero}</h1>
          <p className="mt-4 text-base sm:text-lg text-muted">{PLACEHOLDER.sub}</p>
          <p className="mt-3 text-sm text-muted">{PLACEHOLDER.openDoor}</p>
          <a href="#interest" className="mt-6 inline-block w-full sm:w-auto text-center bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
            Register my interest
          </a>
        </section>

        <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-12 grid gap-10 md:grid-cols-2">
          <div className="space-y-8">
            <div>
              <h2 className="text-lg font-semibold text-ink">What you earn</h2>
              <p className="mt-3 text-sm text-ink">{PLACEHOLDER.earnings}</p>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-ink">How it works</h2>
              <ol className="mt-3 space-y-3 text-sm text-ink">
                {PLACEHOLDER.how.map((step, i) => (
                  <li key={step} className="flex items-start gap-3"><span className="font-semibold text-accent">{i + 1}.</span><span>{step}</span></li>
                ))}
              </ol>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-ink">Who it suits</h2>
              <ul className="mt-3 space-y-3 text-sm text-ink">
                {PLACEHOLDER.suits.map((s) => <li key={s} className="flex items-start gap-3"><Check /><span>{s}</span></li>)}
              </ul>
            </div>
            <p className="text-xs text-muted">
              This is an expression of interest — we’ll follow up with the detail. Prefer to talk?
              Call <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline inline-flex items-center min-h-[44px]">{COMPANY.phone}</a>.
            </p>
          </div>

          {/* ── THE FORM. Still an interest form: no account, no KYC (owner, 2026-09-12). ────────── */}
          <div id="interest" className="bg-surface border border-line rounded-2xl p-5 sm:p-6 shadow-card md:self-start">
            {state === 'sent' ? (
              <div className="text-center py-8">
                <div className="text-3xl mb-2" aria-hidden="true">✅</div>
                <p className="text-ink font-medium">{msg}</p>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4" noValidate>
                <div>
                  <label htmlFor="i-name" className="block text-sm text-muted mb-1">Your name</label>
                  <input id="i-name" className={input} value={form.name} onChange={set('name')} required maxLength={LIMITS.name} autoComplete="name" />
                </div>
                <div>
                  <label htmlFor="i-company" className="block text-sm text-muted mb-1">Company / round</label>
                  <input id="i-company" className={input} value={form.company} onChange={set('company')} maxLength={LIMITS.company} />
                </div>
                <div>
                  <label htmlFor="i-area" className="block text-sm text-muted mb-1">Area covered</label>
                  <input id="i-area" className={input} value={form.area} onChange={set('area')} maxLength={LIMITS.area} placeholder="e.g. West Midlands" />
                </div>
                <div>
                  <label htmlFor="i-email" className="block text-sm text-muted mb-1">Email</label>
                  <input id="i-email" type="email" className={input} value={form.email} onChange={set('email')} required maxLength={LIMITS.email} autoComplete="email" inputMode="email" />
                </div>
                <div>
                  <label htmlFor="i-phone" className="block text-sm text-muted mb-1">Phone</label>
                  <input id="i-phone" type="tel" className={input} value={form.phone} onChange={set('phone')} maxLength={LIMITS.phone} autoComplete="tel" inputMode="tel" />
                </div>
                <div>
                  <label htmlFor="i-message" className="block text-sm text-muted mb-1">Anything to add?</label>
                  <textarea id="i-message" rows={4} className={`${input} resize-y`} value={form.message} onChange={set('message')} maxLength={LIMITS.message} />
                </div>
                {/* Honeypot */}
                <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set('website')} className="hidden" />
                <Turnstile onToken={setToken} />
                {state === 'error' && msg && <p data-testid="interest-error" className="text-sm text-danger">{msg}</p>}
                <button type="submit" data-testid="interest-submit" disabled={state === 'sending'}
                  className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors disabled:opacity-60">
                  {state === 'sending' ? 'Sending…' : 'Register my interest'}
                </button>
              </form>
            )}
          </div>
        </section>
      </RepSiteChrome>
    </>
  );
}

/**
 * A SIGNED-IN REP STILL GETS THE PORTAL. Read the session directly rather than through
 * requireRepPage: that guard redirects a visitor with no session to /rep/login, which is precisely
 * what this page replaces at the root. Here "no session" is the ordinary case and renders the page.
 */
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { authOptions } = await import('@/pages/api/auth/[...nextauth]');
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  if ((session?.user as { actorClass?: string } | undefined)?.actorClass === 'rep') {
    return { redirect: { destination: '/rep', permanent: false } };
  }
  return { props: {} };
};
