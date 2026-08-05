/**
 * File: pages/admin/quotes/index.tsx
 * The QUOTES lens — one row per job card at its LATEST version. A quote is a job card in waiting,
 * not a new object, so rows open the job card exactly as the Job Cards list does.
 *
 * Default filter is AWAITING RESPONSE: that is the working view, the chase list. Accepted quotes are
 * live work and belong in Job Cards — they stay reachable here under their filter but are out of the
 * default. Declined stay visible too; a declined quote is a follow-up opportunity, not a dead record.
 *
 * Site scoping + authority mirror the Job Cards list: getVisibility decides which sites, and the
 * server filters to them — the chips are decoration, this is the control.
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { onboardingGateRedirect } from '@/lib/admin-guard';
import { listQuotes, quoteFilterCounts, QUOTE_FILTERS, isQuoteFilter, DEFAULT_QUOTE_FILTER, type QuoteFilter, type QuoteRow } from '@/lib/quotes-list';
import { formatMoney } from '@/lib/format-money';

type Props = {
  rows: QuoteRow[];
  counts: Record<QuoteFilter, number>;
  filter: QuoteFilter;
  currency: string;
  locale: string;
  siteId: string | null;
};

const LABELS: Record<QuoteFilter, string> = {
  awaiting: 'Awaiting response',
  accepted: 'Accepted',
  declined: 'Declined',
  // The garage never asked, as distinct from the customer never answering.
  needs_resending: 'Needs re-sending',
  expired: 'Expired',
  // Agreed AND in the diary. Last, because it is the only tab needing no action.
  accepted_booked: 'Accepted & booked',
};

const TONE: Record<QuoteFilter, string> = {
  awaiting: 'bg-accent-soft text-accent',
  accepted: 'bg-ok-soft text-ok',
  declined: 'bg-surface-muted text-muted',
  // Amber like expired — both are "no live offer" — but its own tab, because the ACTION differs.
  needs_resending: 'bg-warn-soft text-warn',
  expired: 'bg-warn-soft text-warn',
  accepted_booked: 'bg-ok-soft text-ok',
};

export default function QuotesPage(props: Props) {
  const router = useRouter();
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(props.locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const go = (f: QuoteFilter) => {
    const q: Record<string, string> = { filter: f };
    if (props.siteId) q.site = props.siteId;
    router.push({ pathname: '/admin/quotes', query: q });
  };

  return (
    <>
      <Head><title>Quotes - GreaseDesk</title></Head>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-3xl font-bold text-ink">Quotes</h1>
        {/* Same form as New Job Card (?next=quote), landing on the Quote tab ready to price. */}
        <Link
          href="/admin/jobcards/new?next=quote"
          className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm"
        >
          + New quote
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {QUOTE_FILTERS.map((f) => (
          <button key={f} onClick={() => go(f)}
            className={`text-sm rounded-lg px-3 py-1.5 border transition ${
              props.filter === f ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink hover:bg-surface-muted'}`}>
            {LABELS[f]} <span className="opacity-70">({props.counts[f]})</span>
          </button>
        ))}
      </div>

      {props.rows.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-8 text-center">
          <p className="text-muted text-sm">
            {props.filter === 'awaiting' ? 'No quotes are waiting on a customer right now.' : `No ${LABELS[props.filter].toLowerCase()} quotes.`}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-muted text-xs uppercase tracking-wide border-b border-line">
                <th className="text-left font-medium py-3 px-4">Reg</th>
                <th className="text-left font-medium py-3 px-4">Customer</th>
                <th className="text-right font-medium py-3 px-4">Value</th>
                <th className="text-center font-medium py-3 px-2">Ver.</th>
                <th className="text-left font-medium py-3 px-4">Sent</th>
                <th className="text-left font-medium py-3 px-4">Expires</th>
                <th className="text-left font-medium py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <tr key={r.jobCardId} className="border-b border-line/60 hover:bg-surface-muted">
                  {/* SIX columns inside the row link, STATUS in its own cell — the action below is a
                      link too, and an <a> cannot legally nest inside another <a>. */}
                  <td className="py-0 px-0" colSpan={6}>
                    {/* A quote is a job card in waiting — the row opens the card, same as Job Cards. */}
                    <Link href={`/admin/jobcards/${r.jobCardId}`} className="grid grid-cols-[1fr_1fr_1fr_auto_1fr_1fr] items-center">
                      <span className="py-3 px-4 font-semibold text-ink">{r.registration ?? '—'}</span>
                      <span className="py-3 px-4 text-ink">{r.customerName ?? '—'}</span>
                      <span className="py-3 px-4 text-right text-ink tabular-nums">{formatMoney(r.grossPennies, { currency: props.currency, locale: props.locale })}</span>
                      <span className="py-3 px-2 text-center text-muted tabular-nums">{r.version ? `v${r.version}` : '—'}</span>
                      <span className="py-3 px-4 text-muted">{r.sentAt ? fmtDate(r.sentAt) : '—'}</span>
                      <span className="py-3 px-4 text-muted">{r.expiresAt ? fmtDate(r.expiresAt) : '—'}</span>
                    </Link>
                  </td>
                  <td className="py-3 px-4 align-middle">
                    {/* A verbal quote has no send, no clock and no customer-side record — say so
                        plainly rather than dressing it as a sent quote with blank dates. A
                        superseded latest = the estimate was materially edited and never re-sent,
                        so the customer's link is dead: state the fact AND the remedy, without
                        implying the garage did anything wrong. */}
                    {r.verbal
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-surface-muted text-muted border border-line">Quoted verbally — not sent</span>
                      : r.supersededNoLink
                        ? <span className="text-xs text-warn">Superseded — customer can no longer view this quote.</span>
                        : <span className={`text-xs px-2 py-0.5 rounded-full ${TONE[r.status]}`}>{LABELS[r.status]}</span>}
                    {/* ── THE ACTION THE TAB NAMES ──────────────────────────────────────────────
                        It opens the card AT THE QUOTE rather than sending. Re-sending mints a NEW
                        version from the estimate AS IT STANDS (quote-send → freezeQuoteVersion),
                        and the estimate is exactly what changed — that edit is why the last version
                        was superseded. A one-click send would email a price nobody has looked at
                        since it moved, which is worse than not sending. So: review, then send with
                        the control already on that tab. */}
                    {/* AGREED ONE PRICE, SENT ANOTHER. A row marker rather than a seventh tab —
                        it is a fact about a card that already belongs under Accepted or Accepted &
                        booked, and a tab would split the accepted work in two. Both figures, because
                        "awaiting approval" states nothing. */}
                    {r.priceUnconfirmed && (
                      <span className="block mt-1 text-[11px] font-medium text-warn" data-testid="price-unconfirmed-row">
                        Agreed {formatMoney(r.priceUnconfirmed.agreedPennies, { currency: props.currency, locale: props.locale })} (v{r.priceUnconfirmed.agreedVersion}),
                        {' '}sent {formatMoney(r.priceUnconfirmed.sentPennies, { currency: props.currency, locale: props.locale })} (v{r.priceUnconfirmed.sentVersion}) — not yet agreed
                      </span>
                    )}
                    {r.status === 'needs_resending' && (
                      <Link href={`/admin/jobcards/${r.jobCardId}?tab=quote`} data-testid="quote-resend"
                        className="block mt-1 text-xs font-semibold text-accent hover:underline">
                        Review the price and send a new quote →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted mt-4">
        Expiry is worked out from the send date — a quote past its window shows as Expired whether or not anything has run.
        Quotes given verbally have no send date and never lapse; they stay here until answered.
        Accepted is the to-do list: the customer said yes and nobody has put it in the diary yet.
        Accepted &amp; booked is the same work once it has a lift and a date. Both leave when the job is
        invoiced. Needs re-sending means the price changed after the quote went out and a new one was
        never sent — the customer cannot see a quote at all, which is the opposite of Expired.
      </p>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  const onboard = await onboardingGateRedirect(user.group_id);
  if (onboard) return { redirect: { destination: onboard, permanent: false } };

  const vis = await getVisibility(user.id as string);
  // SERVER-ENFORCED site scope — a ?site= the caller can't access never narrows anything.
  let siteIds = vis.siteIds;
  let siteId: string | null = null;
  const q = ctx.query.site ? String(ctx.query.site) : '';
  if (q && canAccessSite(vis, q)) { siteIds = [q]; siteId = q; }

  const raw = ctx.query.filter ? String(ctx.query.filter) : '';
  const filter: QuoteFilter = isQuoteFilter(raw) ? raw : DEFAULT_QUOTE_FILTER;

  const [rows, counts] = await Promise.all([
    listQuotes({ groupId: user.group_id, siteIds, filter }),
    quoteFilterCounts({ groupId: user.group_id, siteIds }),
  ]);

  const { prisma } = await import('@/lib/db');
  const site = await prisma.site.findFirst({ where: { id: siteIds[0] ?? '' }, select: { currency_code: true, locale: true } });

  return {
    props: {
      rows, counts, filter, siteId,
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
    },
  };
};
