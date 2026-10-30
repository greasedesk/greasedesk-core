/**
 * File: pages/affiliate-site/join.tsx
 * BECOMING AN AFFILIATE: the form, the code from the text, and what they walk away with.
 *
 * ── THREE STATES ON ONE PAGE, AND NO NAVIGATION BETWEEN THEM ───────────────────────────────────
 * form → code → done. One page because the three are one act and a person who has just given us a
 * mobile number should not lose the thread to a redirect; and because the code screen must keep the
 * email it was typed against, which a fresh page load would not have.
 *
 * ── THE SWITCH IS READ ON EVERY REQUEST, SERVER-SIDE ───────────────────────────────────────────
 * Joining shut renders the closed panel and the form is not on the page at all. That is a courtesy:
 * the API checks the same setting on every call, because a form nobody can see is still a POST
 * anybody can make.
 *
 * ── THE TERMS ARE ON THE BUTTON, NOT BEHIND IT ─────────────────────────────────────────────────
 * The money terms are stated above the button, from the settings, and pressing it accepts them —
 * which is what stamps Rep.terms_accepted_at, and what lets a reward accrue at all. So the sentence
 * and the acceptance cannot drift apart: both come from the same resolver on the same request.
 */
import { useState } from 'react';
import type { GetServerSideProps } from 'next';
import Seo from '@/components/marketing/Seo';
import AffiliateSiteChrome from '@/components/affiliate-site/AffiliateSiteChrome';
import { AFFILIATE_SITE_URL, absoluteAffiliateSiteUrl } from '@/lib/company-info';
import { JOIN_LIMITS } from '@/lib/affiliate-join';

const BRAND_ASSET = '/greasedesk-Logo.png'; // the one file outside /affiliate-site this host serves
const input = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-base focus:ring-2 focus:ring-accent focus:border-accent outline-none';
const cta = 'w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors disabled:opacity-60';

type Props = {
  joiningOpen: boolean;
  rewardSentence: string;
  garage: { offerLabel: string; renewalLabel: string; monthsPaid: number; monthsGiven: number };
  holdDays: number;
};

type Done = { name: string; refCode: string; link: string; qr: string | null; emailed: boolean };

export default function AffiliateJoin({ joiningOpen, rewardSentence, garage, holdDays }: Props) {
  const [stage, setStage] = useState<'form' | 'code' | 'done'>('form');
  const [form, setForm] = useState({ name: '', email: '', phone: '', social: '', website: '' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/affiliate-site/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.ok && d.stage === 'code_sent') { setStage('code'); setMsg(d.message ?? null); }
      else if (r.ok && d?.ok && d.stage === 'already') { setMsg(d.message); }
      else setMsg(d?.message || 'Something went wrong. Please try again.');
    } catch { setMsg('We couldn’t reach the server. Please try again shortly.'); }
    finally { setBusy(false); }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/affiliate-site/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, code }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.ok) { setDone({ name: d.name, refCode: d.refCode, link: d.link, qr: d.qr, emailed: !!d.emailed }); setStage('done'); }
      else setMsg(d?.message || 'That code didn’t work. Check it and try again.');
    } catch { setMsg('We couldn’t reach the server. Please try again shortly.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Seo
        title="Become a GreaseDesk affiliate"
        description="Sign up to the GreaseDesk affiliate programme: your name, your email and your mobile."
        path="/affiliate-site/join"
        origin={AFFILIATE_SITE_URL}
        ogImage={absoluteAffiliateSiteUrl(BRAND_ASSET)}
      />
      <AffiliateSiteChrome>
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
          {!joiningOpen ? (
            <div data-testid="join-closed">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">Opening soon</h1>
              <p className="mt-4 text-sm text-muted">
                The programme isn’t open to new affiliates just now. Leave your email on
                the <a href="/" className="text-accent hover:underline">front page</a> and we’ll tell you
                when it opens — everything it pays is set out there.
              </p>
            </div>
          ) : stage === 'done' && done ? (
            // ── WHAT THEY WALK AWAY WITH ────────────────────────────────────────────────────────
            <div data-testid="join-done">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">You’re in{done.name ? `, ${done.name.split(' ')[0]}` : ''}</h1>
              <p className="mt-3 text-sm text-muted">
                {done.emailed
                  ? 'We’ve emailed this to you as well, with a link to confirm your address.'
                  : 'Keep this to hand — we couldn’t send the email just now, so this screen is the only copy.'}
              </p>

              <div className="mt-6 bg-surface border border-line rounded-2xl p-5 sm:p-6 shadow-card">
                <p className="text-xs text-muted">Your referral code</p>
                <p className="mt-1 text-3xl font-extrabold tracking-widest text-ink" data-testid="done-code">{done.refCode}</p>

                <p className="mt-5 text-xs text-muted">Your link — it carries the code for them</p>
                <p className="mt-1 text-sm break-all text-accent" data-testid="done-link">{done.link}</p>

                {done.qr && (
                  <>
                    <p className="mt-5 text-xs text-muted">The same link as a QR code, for a wall or a van</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={done.qr} alt={`QR code for ${done.link}`} className="mt-2 w-40 h-40 border border-line rounded-lg bg-white" data-testid="done-qr" />
                  </>
                )}
              </div>

              <p className="mt-6 text-sm text-ink">{rewardSentence}</p>
              <p className="mt-1 text-sm text-muted">
                Paid {holdDays} days after each of their payments clears. A garage signing up through your
                code gets {garage.monthsGiven} months for the price of {garage.monthsPaid} — {garage.offerLabel} instead
                of {garage.renewalLabel}.
              </p>
              <p className="mt-4 text-xs text-muted">
                UK advertising rules require affiliate content to be labelled as an ad — “#ad” at the start of
                the post or the description — and we ask everyone to do it.
              </p>
            </div>
          ) : stage === 'code' ? (
            // ── THE CODE FROM THE TEXT ──────────────────────────────────────────────────────────
            <form onSubmit={confirm} className="space-y-4" noValidate data-testid="join-code-form">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">Check your phone</h1>
              <p className="text-sm text-muted">
                We’ve texted a code to {form.phone}. Type it in and you’re done — your referral code is on the
                next screen.
              </p>
              <div>
                <label htmlFor="j-code" className="block text-sm text-muted mb-1">The code</label>
                <input id="j-code" data-testid="join-code" className={input} value={code} inputMode="numeric"
                  autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} required />
              </div>
              {msg && <p data-testid="join-error" className="text-sm text-danger">{msg}</p>}
              <button type="submit" className={cta} disabled={busy} data-testid="join-confirm">
                {busy ? 'Checking…' : 'Finish'}
              </button>
              <button type="button" className="text-xs text-muted underline" onClick={() => { setStage('form'); setMsg(null); }}>
                Wrong number? Go back.
              </button>
            </form>
          ) : (
            // ── THE FORM ────────────────────────────────────────────────────────────────────────
            <form onSubmit={submit} className="space-y-4" noValidate data-testid="join-form">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">Become an affiliate</h1>
              <p className="text-sm text-muted">
                Three things and a code to your mobile. There’s nobody to wait for — you’ll have your referral
                code at the end of it.
              </p>

              <div>
                <label htmlFor="j-name" className="block text-sm text-muted mb-1">Your name</label>
                <input id="j-name" data-testid="join-name" className={input} value={form.name} onChange={set('name')}
                  required maxLength={JOIN_LIMITS.name} autoComplete="name" />
              </div>
              <div>
                <label htmlFor="j-email" className="block text-sm text-muted mb-1">Email</label>
                <input id="j-email" data-testid="join-email" type="email" className={input} value={form.email} onChange={set('email')}
                  required maxLength={JOIN_LIMITS.email} autoComplete="email" inputMode="email" />
              </div>
              <div>
                <label htmlFor="j-phone" className="block text-sm text-muted mb-1">Mobile</label>
                <input id="j-phone" data-testid="join-phone" type="tel" className={input} value={form.phone} onChange={set('phone')}
                  required maxLength={JOIN_LIMITS.phone} autoComplete="tel" inputMode="tel" />
                <p className="mt-1 text-xs text-muted">We text a code to it. It is not published anywhere.</p>
              </div>
              <div>
                <label htmlFor="j-social" className="block text-sm text-muted mb-1">Channel or handle (optional)</label>
                <input id="j-social" data-testid="join-social" className={input} value={form.social} onChange={set('social')}
                  maxLength={JOIN_LIMITS.social} placeholder="e.g. a YouTube channel" />
              </div>
              {/* Honeypot: a real person never fills a hidden field. */}
              <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website}
                onChange={set('website')} className="hidden" />

              {/* THE TERMS, ABOVE THE BUTTON THAT ACCEPTS THEM, from the same settings the reward
                  itself is computed from. */}
              <div className="bg-surface-muted border border-line rounded-lg p-4 text-sm text-ink" data-testid="join-terms">
                <p>{rewardSentence}</p>
                <p className="mt-2 text-muted">
                  Paid {holdDays} days after each payment clears, by bank transfer. A full refund of a garage’s
                  payment reverses what it earned; a partial refund doesn’t. You can’t earn on a garage you own or
                  work for. The <a href="/terms" className="text-accent hover:underline">affiliate terms</a> have
                  the rest.
                </p>
              </div>

              {msg && <p data-testid="join-error" className="text-sm text-danger">{msg}</p>}
              <button type="submit" className={cta} disabled={busy} data-testid="join-submit">
                {busy ? 'Sending the code…' : 'Accept and text me a code'}
              </button>
            </form>
          )}
        </section>
      </AffiliateSiteChrome>
    </>
  );
}

/** The switch and the figures, on every request — no ISR, so closing the programme closes this page. */
export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const { prisma } = await import('@/lib/db');
  const { currentTerms, AFFILIATE_HOLD_DAYS } = await import('@/lib/affiliate');
  const { publicPlanChoice } = await import('@/lib/plan-choice');
  const { rewardFigures, rewardSentence } = await import('@/lib/affiliate-public');

  const terms = await currentTerms(prisma);
  const figures = rewardFigures({ totalRewardPennies: terms.totalRewardPennies, instalmentPennies: terms.instalmentPennies });
  const choice = await publicPlanChoice(prisma, { referred: true });

  return {
    props: {
      joiningOpen: terms.joiningOpen,
      rewardSentence: rewardSentence(figures),
      holdDays: AFFILIATE_HOLD_DAYS,
      garage: {
        offerLabel: choice.annual.totalLabel,
        renewalLabel: choice.annual.renewalTotalLabel,
        monthsPaid: choice.annual.monthsPaid,
        monthsGiven: choice.annual.monthsGiven,
      },
    },
  };
};
