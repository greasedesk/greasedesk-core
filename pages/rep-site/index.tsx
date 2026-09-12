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
 * ── THE COPY IS THE OWNER'S, VERBATIM (2026-09-12) ──────────────────────────────────────────────
 * It was placeholder until the owner supplied it; see COPY below. Nothing here invents an earnings
 * figure, a garage count, a testimonial or a partner name, and `earnings` deliberately carries NO
 * number — /reseller's own header recorded that decision when the commission model was unsettled and
 * the owner confirmed it still holds. Commercial rates are given on registration.
 *
 * The TERMS page is still placeholder, and that is a separate decision: the real agreement exists but
 * is not solicitor-reviewed, and the owner is not publishing terms ahead of that review.
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

/**
 * THE OWNER'S COPY, verbatim (supplied 2026-09-12). Not placeholder any more, and not to be edited
 * here: the words are his. The apostrophes are typographic (’) to match the rest of the site —
 * supplied straight, which the owner confirmed was an artefact of typing into a chat window rather
 * than a choice. That is the ONLY character changed from what he sent.
 *
 * `earnings` carries NO figure, which is the standing ruling — commercial rates are given on
 * registration, not published. Do not add one.
 *
 * Each `how` step has a TITLE and a BODY because the supplied copy does; the step NUMBER comes from
 * the renderer, as it always did, so it is not repeated in the text.
 */
const COPY = {
  hero: 'Introduce GreaseDesk to the garages you already visit.',
  sub: 'Whether you run a regular trade round or you’re an ambitious self-starter with the time to build a local route, GreaseDesk pays you an ongoing monthly commission to be our person on the ground. Introduce modern workshop software to independent garages, drop in monthly to keep them happy, and earn every month they stay active.',
  openDoor: 'You don’t need a van or motor-trade pedigree — just the initiative to visit workshops, build real relationships, and act as their trusted local contact.',
  earnings: 'A monthly commission on every active garage in your portfolio. You get paid for each month the subscription clears and your monthly check-in is complete. No arbitrary sales targets. Full commercial rates, payment schedules and terms are provided on registration.',
  how: [
    { title: 'Sign up the garage', body: 'Talk to local workshop owners about ditching messy paperwork and outdated systems. Get them started on GreaseDesk using your rep link.' },
    { title: 'Be the local contact', body: 'Drop in once a month to check how the system is running and handle basic first-line questions. We back you up with deep technical support and product updates whenever you need us.' },
    { title: 'Invoice and get paid monthly', body: 'Log your verified visits, invoice against each closed pay run, and get paid by bank transfer. You earn for as long as the garage stays a paying GreaseDesk client and you stay an active rep.' },
  ],
  suits: [
    'Tool-van reps and consumables suppliers visiting garages on an established round',
    'Motor factor reps, delivery drivers, and calibration engineers',
    'Motivated self-starters with spare time to build and look after a local garage portfolio',
    'Retired garage owners, ex-mechanics, and trade consultants with trusted local connections',
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
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-ink tracking-tight">{COPY.hero}</h1>
          <p className="mt-4 text-base sm:text-lg text-muted">{COPY.sub}</p>
          <p className="mt-3 text-sm text-muted">{COPY.openDoor}</p>
          <a href="#interest" className="mt-6 inline-block w-full sm:w-auto text-center bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
            Register my interest
          </a>
        </section>

        <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-12 grid gap-10 md:grid-cols-2">
          <div className="space-y-8">
            <div>
              <h2 className="text-lg font-semibold text-ink">What you earn</h2>
              <p className="mt-3 text-sm text-ink">{COPY.earnings}</p>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-ink">How it works</h2>
              <ol className="mt-3 space-y-3 text-sm text-ink">
                {COPY.how.map((step, i) => (
                  <li key={step.title} className="flex items-start gap-3">
                    <span className="font-semibold text-accent shrink-0">{i + 1}.</span>
                    <span><span className="font-medium text-ink">{step.title}</span><br />{step.body}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-ink">Who it suits</h2>
              <ul className="mt-3 space-y-3 text-sm text-ink">
                {COPY.suits.map((s) => <li key={s} className="flex items-start gap-3"><Check /><span>{s}</span></li>)}
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
