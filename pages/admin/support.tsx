/**
 * File: pages/admin/support.tsx
 * Support — how a garage reaches GreaseDesk when something is wrong.
 *
 * ── THE NUMBER IS THE PAGE ──────────────────────────────────────────────────────────────────────
 * This content lived at Settings → Account → My Rep: four levels down, under a label naming a
 * person most garages do not have (there are no reps, so every tenant read the empty state). A
 * garage whose diary is broken at eight in the morning was never going to find it. The order is now
 * what someone in trouble needs: the number, then a message, then who introduced them.
 *
 * ── NO ROLE GATE (ruling 2026-08-09, carried over) ──────────────────────────────────────────────
 * Every role sees it. Knowing who to call is not privileged, and the person who actually picks up
 * the phone in a workshop is rarely the account holder. Nothing commercial is on the page: the
 * rep's share, payout details and referral code are withheld at the resolver, not hidden here.
 *
 * ── THE FORM IS HOSTED, NOT LINKED ──────────────────────────────────────────────────────────────
 * The old page linked to /contact. That is a MARKETING route — public site chrome, and outside
 * _app's isAppRoute, so a signed-in garage clicking it got a cookie banner. It posts to the same
 * /api/contact, which takes the name and email from the SESSION for a signed-in tenant, so the only
 * thing to type is the problem.
 *
 * ── A REP IS NOT A SUPPORT DESK ─────────────────────────────────────────────────────────────────
 * The rep card is a section beneath, never the whole page. A rep is a salesperson; routing a garage
 * with a broken diary to the person who signed them up costs them a day.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { tenantRep, type TenantRep } from '@/lib/tenant-rep';
import { COMPANY } from '@/lib/company-info';

type PageProps = { rep: TenantRep | null };

export default function Support({ rep }: PageProps) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json().catch(() => ({}));
      // NEVER A SILENT FAILURE: the error names the phone, which is the route that does not depend
      // on our email provider being up.
      if (!res.ok || !data?.ok) { setError(data?.message || `Sorry — we couldn’t send that. Please call ${COMPANY.phone}.`); return; }
      setSent(true); setMessage('');
    } catch {
      setError(`Sorry — we couldn’t send that. Please call ${COMPANY.phone}.`);
    } finally { setBusy(false); }
  }

  return (
    <>
      <Head><title>Support - GreaseDesk</title></Head>
      <div className="p-6 max-w-2xl">
        <h1 className="text-2xl font-bold text-ink mb-1">Support</h1>
        <p className="text-sm text-muted mb-6">Something not working as it should? Talk to the GreaseDesk team.</p>

        {/* THE NUMBER FIRST, and large. A garage that cannot use the product cannot wait on email. */}
        <div className="bg-surface border border-line rounded-xl p-6 shadow-card">
          <p className="text-sm text-muted">Call us</p>
          <a data-testid="support-phone" href={`tel:${COMPANY.phoneE164}`}
            className="text-3xl font-bold text-accent hover:underline block mt-1">{COMPANY.phone}</a>
          <p className="text-sm text-muted mt-2">Monday to Friday. This is the fastest way to reach us.</p>
        </div>

        <div className="bg-surface border border-line rounded-xl p-6 mt-4">
          <h2 className="text-lg font-semibold text-ink mb-1">Or send us a message</h2>
          {/* No name or email field: we know who is signed in, and asking again is a form to get
              wrong. The route reads both from the session. */}
          <p className="text-sm text-muted mb-3">We’ll reply to the email address on your account.</p>
          {sent ? (
            <p data-testid="support-sent" className="text-sm text-ok font-medium">Thanks — we’ll be in touch shortly.</p>
          ) : (
            <>
              <textarea data-testid="support-message" value={message} onChange={(e) => setMessage(e.target.value)}
                rows={5} maxLength={5000} placeholder="What’s happening?"
                className="w-full p-3 bg-surface border border-line rounded-lg text-ink text-sm" />
              {error && <p className="text-sm text-danger mt-2">{error}</p>}
              <button data-testid="support-send" onClick={send} disabled={busy || message.trim().length === 0}
                className="mt-3 bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">
                {busy ? 'Sending…' : 'Send message'}
              </button>
            </>
          )}
        </div>

        {/* ── WHO INTRODUCED THIS GARAGE ─────────────────────────────────────────────────────────
            A section, not the page. Three states; the third — fallen back to an area manager —
            collapses into the second until an assignment field exists, which is honest: from the
            garage's side there is no named individual either way. */}
        <div className="bg-surface border border-line rounded-xl p-6 mt-4">
          <h2 className="text-lg font-semibold text-ink mb-1">Your GreaseDesk rep</h2>
          {rep ? (
            <div data-testid="rep-card">
              <p className="text-base font-semibold text-ink mt-3">{rep.name}</p>
              {/* The number is OMITTED when absent — never a placeholder, and never a dead tel:. */}
              {rep.phone && (
                <p className="text-sm mt-0.5">
                  {rep.phoneE164
                    ? <a className="text-accent" href={`tel:${rep.phoneE164}`}>{rep.phone}</a>
                    : <span className="text-ink">{rep.phone}</span>}
                </p>
              )}
              <p className="text-sm mt-0.5"><a className="text-accent" href={`mailto:${rep.email}`}>{rep.email}</a></p>
              <p className="text-sm text-muted mt-3">
                {rep.name.split(' ')[0]} introduced you to GreaseDesk and is your first point of contact
                for questions about your account or subscription. For anything not working, call the
                number above — that reaches us directly and is usually faster.
              </p>
            </div>
          ) : (
            <div data-testid="rep-empty">
              <p className="text-sm text-ink mt-2">You don’t have a rep — you signed up directly with GreaseDesk.</p>
              <p className="text-sm text-muted mt-1">That’s perfectly normal, and nothing is missing from your account.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id || !u?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  return { props: { rep: await tenantRep(u.group_id as string) } };
};
