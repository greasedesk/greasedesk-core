/**
 * File: pages/c/[token].tsx
 * The CUSTOMER end of a magic link. No session, no login — the URL is the credential (see the
 * security model in lib/magic-link). Resolution happens SERVER-SIDE in getServerSideProps, so an
 * invalid link never renders card data and the token never becomes client state.
 *
 * ── ONE ROUTE, DISPATCHED ON PURPOSE ────────────────────────────────────────────────────────────
 * This used to resolve with `purpose: 'quote_view'` hardcoded — a quote route wearing a generic
 * name. It now resolves the token first and branches on what the link is FOR:
 *   quote_view   → the quote, with accept/decline
 *   invoice_pay  → one frozen invoice (paying it is a later slice; this renders the document)
 *   portal_view  → DELIBERATELY DARK. A valid stored purpose with no destination built. It is
 *                  refused in words rather than half-rendered: wiring the dispatcher is not the
 *                  same as wiring every arm, and a branch that renders a blank page is worse than
 *                  one that says "not available".
 *
 * BOTH documents render through the SHARED shapes — lib/quote-doc and lib/invoice-doc — and the
 * SHARED line/totals component (components/DocumentLines) that the ADMIN invoice view also uses. A
 * fourth renderer is how four surfaces start disagreeing about VAT, so there isn't one: this is a
 * third consumer of the existing two.
 *
 * Read-only APART FROM accept/decline. Per the amended magic-link rule (2026-08-15) a link may
 * carry a payment TOWARD a frozen invoice but never a movement that removes value; nothing on this
 * page removes anything.
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
import { buildInvoiceDoc, type InvoiceDoc } from '@/lib/invoice-doc';
import { canOfferCardPayment } from '@/lib/invoice-payment-intent';
import { balanceOwedPennies } from '@/lib/invoice';
import DocumentLines from '@/components/DocumentLines';
import CustomerInvoice, { type SerializedInvoiceDoc } from '@/components/customer/CustomerInvoice';
import { useState } from 'react';

type Denied =
  | 'expired' | 'revoked' | 'not_found' | 'rate_limited' | 'wrong_purpose' | 'no_quote'
  | 'no_invoice' | 'not_available';

type Props =
  | { state: 'quote'; doc: SerializedDoc; token: string }
  | { state: 'invoice'; doc: SerializedInvoiceDoc; token: string; canPay: boolean; returningFromPayment: boolean }
  | { state: 'denied'; reason: Denied; revokedReason?: string | null; garagePhone: string | null };

type SerializedDoc = Omit<QuoteDoc, 'sentAt' | 'expiresAt'> & { sentAt: string; expiresAt: string };

const DENIED_COPY: Record<Denied, { title: string; body: string }> = {
  expired: {
    title: 'This quote has expired',
    body: `Quote links stay valid for ${MAGIC_LINK_DAYS} days. Your job and its details are safe — only the link has aged out. Please contact the garage and ask them to send a fresh one.`,
  },
  revoked: {
    // THE FALLBACK, for a link revoked before we recorded why (every row before 2026-08-08) and for
    // states with no true reason word — see REVOKED_COPY below, which overrides this when we know.
    // It must claim NOTHING about the cause: the old single sentence said "this quote has been
    // updated — ask for the current version", which was a flat lie on an invoiced job, sending the
    // customer to the garage for a document that does not exist.
    title: 'This quote is no longer available',
    body: 'This link has been closed by the garage. Please contact them — they can tell you where things stand, and send a new quote if you need one.',
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
  no_invoice: {
    title: 'We couldn’t open that invoice',
    body: 'The link is valid but the invoice it points to isn’t available. Please contact the garage and ask them to resend it.',
  },
  // portal_view. Says what is true — the link works, the destination does not exist yet — and
  // names a next step that does. Never a blank page pretending to be a feature.
  not_available: {
    title: 'This link isn’t available yet',
    body: 'This kind of link isn’t something we can open for you yet. Please contact the garage — they can send you your quote or invoice directly.',
  },
};

/**
 * WHY the link died, in the customer's language. Overrides DENIED_COPY.revoked when the cause was
 * recorded; an unrecognised or absent reason falls back to the neutral sentence above.
 *
 * Each of these has to be true STANDING ALONE, name no next step that doesn't exist, and never
 * blame the customer for a state the garage created.
 */
const REVOKED_COPY: Record<string, { title: string; body: string }> = {
  superseded: {
    title: 'This quote has been updated',
    body: 'A newer version of this quote has been sent. Please open the most recent message from the garage, or ask them to resend it.',
  },
  invoiced: {
    // Deliberately does NOT say an invoice was sent to them — we know one was raised, not that it
    // arrived, and "check your email" would be a guess pointing at an empty inbox.
    title: 'This work has now been invoiced',
    body: 'The garage has invoiced this job, so this quote is no longer open for approval. If you haven’t received the invoice, or something on it doesn’t look right, please contact the garage.',
  },
  declined: {
    // PASSIVE ON PURPOSE. Staff can decline on a customer's behalf over the phone, so "you declined
    // this" would sometimes be a false accusation aimed at the one person who didn't do it.
    title: 'This quote was declined',
    body: 'This quote is no longer open. If that wasn’t what you meant, or you’d like to go ahead after all, please contact the garage — they can send you a fresh quote.',
  },
  cancelled: {
    title: 'This job has been cancelled',
    body: 'The garage has cancelled this job, so the quote is no longer open. If you think that’s a mistake, please give them a call.',
  },
};

const shellCls = 'min-h-screen bg-surface-muted py-6 px-4';
const cardCls = 'bg-surface border border-line rounded-2xl shadow-sm max-w-2xl mx-auto p-5 sm:p-8';

export default function CustomerLinkPage(props: Props) {
  if (props.state === 'invoice') {
    return (
      <CustomerInvoice
        doc={props.doc}
        token={props.token}
        canPay={props.canPay}
        returningFromPayment={props.returningFromPayment}
      />
    );
  }
  if (props.state === 'denied') {
    // A recorded reason overrides the generic revoked copy; anything unrecognised falls back to it,
    // so a reason word added later can never render a blank page before its copy is written.
    const copy = (props.reason === 'revoked' && props.revokedReason && REVOKED_COPY[props.revokedReason])
      || DENIED_COPY[props.reason];
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

          {/* WHY THE PRICE MOVED. The customer arrived from an email they may have skimmed, so the
              explanation has to be on the page they land on — not only in the message. Above the
              work description, and visually distinct from it: this is the new information. */}
          {d.revisionNote && (
            <div className="mb-3 rounded-lg border-l-4 border-warn bg-warn-soft p-3" data-testid="revision-note">
              <p className="text-xs uppercase tracking-wide text-warn mb-1">What&rsquo;s changed</p>
              <p className="text-ink whitespace-pre-line">{d.revisionNote}</p>
            </div>
          )}

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
  // NO PURPOSE FILTER. The token decides what it opens; passing one here is what made this a quote
  // route with a generic name. `wrong_purpose` therefore cannot come back from this call any more —
  // its copy is retained because other callers (quote-respond) still resolve with a filter, and an
  // unreachable branch is cheaper than a missing one.
  const res = await resolveMagicLink(token, { ip: clientIp(ctx.req.headers as any) });

  if (!res.ok) {
    // Even a refusal should offer the phone where we can identify the garage cheaply — but a
    // not-found token identifies nothing, so the number is simply absent there.
    // `revokedReason` decides WHICH revoked sentence renders. Serialised as null, never undefined —
    // Next refuses to serialise undefined through getServerSideProps.
    return { props: { state: 'denied', reason: res.reason, revokedReason: res.revokedReason ?? null, garagePhone: null } };
  }

  // ── INVOICE ────────────────────────────────────────────────────────────────────────────────
  if (res.link.purpose === 'invoice_pay') {
    // The link names its invoice; it is never resolved through the card. See the schema comment on
    // CustomerMagicLink.invoice_id — a card can carry several invoices over its life and keeps
    // moving after each one freezes.
    if (!res.link.invoiceId) {
      return { props: { state: 'denied', reason: 'no_invoice', garagePhone: null } };
    }
    const invDoc = await buildInvoiceDoc(res.link.invoiceId, res.link.groupId);
    if (!invDoc) {
      const site = await prisma.jobCard.findUnique({ where: { id: res.link.jobCardId }, select: { site: { select: { phone: true } } } });
      return { props: { state: 'denied', reason: 'no_invoice', garagePhone: site?.site?.phone ?? null } };
    }
    // Whether to OFFER payment is the endpoint's rule, asked here so the page cannot advertise
    // something the endpoint would refuse.
    const totalPennies = invDoc.vatRegistered ? invDoc.totals.grossPennies : invDoc.totals.netPennies;
    const canPay = await canOfferCardPayment({
      groupId: res.link.groupId,
      doc: invDoc,
      balancePennies: balanceOwedPennies({ amount_paid_pennies: invDoc.amountPaidPennies }, totalPennies),
    });
    return {
      props: {
        state: 'invoice',
        token,
        canPay,
        returningFromPayment: String(ctx.query.pay ?? '') === 'processing',
        doc: {
          ...invDoc,
          issuedAt: invDoc.issuedAt.toISOString(),
          paidAt: invDoc.paidAt ? invDoc.paidAt.toISOString() : null,
          voidedAt: invDoc.voidedAt ? invDoc.voidedAt.toISOString() : null,
          datePaid: invDoc.datePaid ? new Date(invDoc.datePaid).toISOString() : null,
          // Not rendered by the customer view, and Next refuses to serialise a Date or undefined.
          confirmDueAt: null, receiptSentAt: null,
        } as any,
      },
    };
  }

  // ── PORTAL: DELIBERATELY DARK ──────────────────────────────────────────────────────────────
  // A valid purpose with no destination. Refused in words. The day the portal is built this arm
  // becomes a render; until then it must not pretend to be one.
  if (res.link.purpose === 'portal_view') {
    const site = await prisma.jobCard.findUnique({ where: { id: res.link.jobCardId }, select: { site: { select: { phone: true } } } });
    return { props: { state: 'denied', reason: 'not_available', garagePhone: site?.site?.phone ?? null } };
  }

  // ── QUOTE ──────────────────────────────────────────────────────────────────────────────────
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
      state: 'quote',
      token,
      doc: { ...doc, sentAt: doc.sentAt.toISOString(), expiresAt: doc.expiresAt.toISOString() },
    },
  };
};
