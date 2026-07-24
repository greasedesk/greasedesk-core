/**
 * File: pages/c/[token].tsx
 * The CUSTOMER end of a magic link. No session, no login — the URL is the credential (see the
 * security model in lib/magic-link). Resolution happens SERVER-SIDE in getServerSideProps, so an
 * invalid link never renders card data and the token never becomes client state.
 *
 * The quote renders through the SHARED document shape (lib/quote-doc) and the SHARED line/totals
 * component (components/DocumentLines) that the invoice view also uses — the quote and the invoice
 * are one document rendered twice, not two that happen to agree.
 *
 * Read-only APART FROM accept/decline. Per the magic-link rule this page authorises no money
 * movement and no destructive action — accepting writes one decision onto one frozen version.
 *
 * Expired / revoked / unknown links EXPLAIN THEMSELVES rather than 404ing — a 404 reads as "the
 * garage's system is broken"; the truth is "your link aged out, ask for a new one".
 */
import React from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { resolveMagicLink, MAGIC_LINK_DAYS } from '@/lib/magic-link';
import { clientIp } from '@/lib/auth-rate-limit';
import { buildQuoteDoc, type QuoteDoc } from '@/lib/quote-doc';
import DocumentLines from '@/components/DocumentLines';
import { useState } from 'react';

type Denied = 'expired' | 'revoked' | 'not_found' | 'rate_limited' | 'wrong_purpose' | 'no_quote';

type Props =
  | { state: 'ok'; doc: SerializedDoc; token: string }
  | { state: 'denied'; reason: Denied; garagePhone: string | null };

type SerializedDoc = Omit<QuoteDoc, 'sentAt' | 'expiresAt'> & { sentAt: string; expiresAt: string };

const DENIED_COPY: Record<Denied, { title: string; body: string }> = {
  expired: {
    title: 'This quote has expired',
    body: `Quote links stay valid for ${MAGIC_LINK_DAYS} days. Your job and its details are safe — only the link has aged out. Please contact the garage and ask them to send a fresh one.`,
  },
  revoked: {
    title: 'This quote is no longer current',
    body: 'The garage has updated or withdrawn this quote, so this link no longer opens it. If they sent you a newer quote, please use that link instead — otherwise give them a call.',
  },
  not_found: {
    title: "We couldn't find that quote",
    body: 'The address may have been copied incompletely — these links are long and email clients sometimes break them across lines. Try opening it again from the original message, or ask the garage to resend it.',
  },
  wrong_purpose: {
    title: "This link doesn't open a quote",
    body: 'Please use the link exactly as the garage sent it, or ask them to resend it.',
  },
  rate_limited: {
    title: 'Too many attempts',
    body: 'Too many links have been opened from this connection in the last hour. Please wait a little while and try again.',
  },
  no_quote: {
    title: 'This quote isn’t ready yet',
    body: 'The garage hasn’t finished preparing this quote. Please give them a call — they’ll be able to tell you where things are.',
  },
};

const shellCls = 'min-h-screen bg-surface-muted py-6 px-4';
const cardCls = 'bg-surface border border-line rounded-2xl shadow-sm max-w-2xl mx-auto p-5 sm:p-8';

export default function CustomerQuotePage(props: Props) {
  if (props.state === 'denied') {
    const copy = DENIED_COPY[props.reason];
    return (
      <>
        <Head><title>{copy.title} — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
        <div className={shellCls}>
          <div className={cardCls}>
            <h1 className="text-xl font-bold text-ink mb-2">{copy.title}</h1>
            <p className="text-sm text-muted leading-relaxed">{copy.body}</p>
            {/* Never a dead end: "call me about this" should be a phone call, not a form. */}
            {props.garagePhone && (
              <p className="mt-4 text-sm text-ink">
                Call the garage: <a className="text-accent font-semibold" href={`tel:${props.garagePhone.replace(/\s/g, '')}`}>{props.garagePhone}</a>
              </p>
            )}
          </div>
        </div>
      </>
    );
  }

  const d = props.doc;
  const expiry = new Date(d.expiresAt).toLocaleDateString(d.locale, { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <>
      <Head><title>Your quote from {d.company.name} — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <div className={shellCls}>
        <div className={cardCls}>
          {/* Tenant branding — this is the GARAGE's document, GreaseDesk is only the carrier. */}
          <div className="flex items-start justify-between gap-4 pb-5 border-b border-line">
            <div>
              {d.logoUrl
                ? <img src={d.logoUrl} alt={d.company.name} className="h-12 w-auto mb-2 object-contain" />
                : <h2 className="text-lg font-bold text-ink">{d.company.name}</h2>}
              {d.company.address && <p className="text-xs text-muted whitespace-pre-line mt-1">{d.company.address}</p>}
              {d.company.phone && <p className="text-xs text-muted mt-1">{d.company.phone}</p>}
              {d.vatRegistered && d.company.vatNumber && (
                <p className="text-xs text-muted mt-1">{d.taxLabel} no. {d.company.vatNumber}</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs uppercase tracking-wide text-muted">Quote</p>
              <p className="text-sm font-semibold text-ink">v{d.version}</p>
            </div>
          </div>

          {/* Vehicle + customer */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-5 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted mb-1">Vehicle</p>
              <p className="text-ink font-semibold">{d.vehicle.reg ?? '—'}</p>
              {d.vehicle.desc && <p className="text-muted">{d.vehicle.desc}</p>}
              {d.vehicle.mileage != null && <p className="text-muted">{d.vehicle.mileage.toLocaleString(d.locale)} miles</p>}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted mb-1">Prepared for</p>
              <p className="text-ink">{d.customer.name || '—'}</p>
            </div>
          </div>

          {d.jobDescription && (
            <div className="pb-2 text-sm">
              <p className="text-xs uppercase tracking-wide text-muted mb-1">Work</p>
              <p className="text-ink whitespace-pre-line">{d.jobDescription}</p>
            </div>
          )}

          {/* THE shared line table + totals — same component the invoice renders. */}
          <DocumentLines
            lines={d.lines}
            totals={d.totals}
            showVat={d.vatRegistered}
            currency={d.currency}
            locale={d.locale}
            labels={{
              description: 'Description', qty: 'Qty', unitPrice: 'Unit price',
              vatRate: `${d.taxLabel} rate`, net: 'Net', amount: 'Amount',
              subtotal: `Subtotal (excl. ${d.taxLabel})`,
              vatAt: (rate) => `${d.taxLabel} at ${rate}%`,
              totalVat: `Total ${d.taxLabel}`, grandTotal: 'Total', total: 'Total',
            }}
          />

          <p className="mt-6 text-sm text-muted">
            This quote is valid until <span className="text-ink font-medium">{expiry}</span>.
          </p>

          <Respond token={props.token} doc={d} />

          <p className="mt-6 text-[11px] text-muted">
            Anyone with this link can view the quote — please don’t forward it.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * Accept / decline. NEITHER IS A DEAD END: the garage's number is shown alongside, resolved
 * site → group. When NO number exists anywhere the page says so explicitly — an escape hatch that
 * silently disappears is the failure mode we're avoiding, so the gap is visible to the customer
 * (and therefore reported back to the garage) rather than absent without trace.
 */
function Respond({ token, doc }: { token: string; doc: SerializedDoc }) {
  const [busy, setBusy] = useState<null | 'accept' | 'decline'>(null);
  const [outcome, setOutcome] = useState<string | null>(
    doc.status === 'accepted' || doc.status === 'declined' ? doc.status : null,
  );
  const [err, setErr] = useState<string | null>(null);

  async function respond(action: 'accept' | 'decline') {
    if (action === 'decline' && !window.confirm('Decline this quote? The garage will be told.')) return;
    setBusy(action); setErr(null);
    try {
      const r = await fetch('/api/quote-respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.message || 'Something went wrong — please call the garage.'); return; }
      setOutcome(j.outcome);
    } catch { setErr('Something went wrong — please call the garage.'); }
    finally { setBusy(null); }
  }

  // Phone and WhatsApp are INDEPENDENT: either, both or neither. The warning fires only when the
  // resolver says there is no route at all — an escape hatch must never vanish without trace.
  const c = doc.contact;
  const phoneBlock = c.setupGap ? (
    <p className="mt-1 text-sm text-warn">
      No contact number has been set up for this garage yet — please reply to the email they sent you.
    </p>
  ) : (
    <div className="mt-1 flex flex-col sm:flex-row sm:items-center gap-2">
      {c.phoneHref && (
        <a className="text-accent font-semibold" href={c.phoneHref}>{c.phone}</a>
      )}
      {c.whatsappUrl && (
        <a href={c.whatsappUrl} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-1.5 bg-ok-soft text-ok w-fit">
          <span aria-hidden>💬</span> Message on WhatsApp
        </a>
      )}
    </div>
  );

  if (outcome === 'accepted') {
    return (
      <div className="mt-6 pt-5 border-t border-line">
        <div className="rounded-lg bg-ok-soft text-ok p-3 text-sm font-semibold">
          Thank you — you've accepted this quote. The garage will be in touch to book you in.
        </div>
        <div className="mt-4 text-sm"><p className="text-muted">Need to change something?</p>{phoneBlock}</div>
      </div>
    );
  }
  if (outcome === 'declined') {
    return (
      <div className="mt-6 pt-5 border-t border-line">
        <div className="rounded-lg bg-surface-muted text-ink p-3 text-sm">
          You've declined this quote and the garage has been told.
        </div>
        <div className="mt-4 text-sm"><p className="text-muted">Changed your mind, or want to talk it through?</p>{phoneBlock}</div>
      </div>
    );
  }

  return (
    <div className="mt-6 pt-5 border-t border-line">
      <div className="flex flex-col sm:flex-row gap-2">
        <button type="button" disabled={busy !== null} onClick={() => respond('accept')}
          className="flex-1 text-sm font-semibold rounded-lg px-4 py-3 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
          {busy === 'accept' ? 'Accepting…' : 'Accept quote'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => respond('decline')}
          className="flex-1 text-sm font-semibold rounded-lg px-4 py-3 bg-surface-muted border border-line text-ink disabled:opacity-50">
          {busy === 'decline' ? 'Declining…' : 'Decline quote'}
        </button>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <div className="mt-4 text-sm">
        <p className="text-muted">Questions, or want to talk it through first?</p>
        {phoneBlock}
      </div>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const token = String(ctx.params?.token ?? '');
  const res = await resolveMagicLink(token, { purpose: 'quote_view', ip: clientIp(ctx.req.headers as any) });

  if (!res.ok) {
    // Even a refusal should offer the phone where we can identify the garage cheaply — but a
    // not-found token identifies nothing, so the number is simply absent there.
    return { props: { state: 'denied', reason: res.reason, garagePhone: null } };
  }

  // The version this link was minted for; if it has been superseded the link is already revoked,
  // so reaching here means it is still the live offer.
  const version = await prisma.quoteVersion.findFirst({
    where: { job_card_id: res.link.jobCardId, magic_link_id: res.link.id },
    select: { id: true },
  });
  if (!version) {
    const site = await prisma.jobCard.findUnique({ where: { id: res.link.jobCardId }, select: { site: { select: { phone: true } } } });
    return { props: { state: 'denied', reason: 'no_quote', garagePhone: site?.site?.phone ?? null } };
  }

  const doc = await buildQuoteDoc(version.id, res.link.expiresAt);
  if (!doc) return { props: { state: 'denied', reason: 'no_quote', garagePhone: null } };

  return {
    props: {
      state: 'ok',
      token,
      doc: { ...doc, sentAt: doc.sentAt.toISOString(), expiresAt: doc.expiresAt.toISOString() },
    },
  };
};
