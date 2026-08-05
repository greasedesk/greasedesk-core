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
import React, { useCallback, useEffect, useState } from 'react';
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
import { withI18n } from '@/lib/gssp-i18n';
import PeriodPicker, { type PeriodSelection } from '@/components/PeriodPicker';
import ConversionChart from '@/components/quotes/ConversionChart';
import { namedMonthRangeQS } from '@/lib/dashboard-periods';
import type { QuotesMetrics } from '@/lib/quotes-metrics';

type Props = {
  rows: QuoteRow[];
  counts: Record<QuoteFilter, number>;
  filter: QuoteFilter;
  currency: string;
  locale: string;
  siteId: string | null;
  fyStartMonth: number;
  accountRef: string;
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

  const money = (p: number) => formatMoney(p, { currency: props.currency, locale: props.locale });
  const PERIOD_KEY = `gd.quotes.period.${props.accountRef}`;
  const [period, setPeriod] = useState<PeriodSelection>({ preset: 'this_month', customFrom: '', customTo: '' });
  const [data, setData] = useState<null | { beforeData: boolean; dataStart: string | null;
    awaitingPennies: number; awaitingCount: number; awaitingVerbalCount: number; metrics: QuotesMetrics | null }>(null);
  const [busy, setBusy] = useState(false);

  // The SERVER resolves every window; the client only names one. A named month expands through the
  // one place that expansion lives, so the panel and the dashboard cannot disagree about what
  // "June 2026" means.
  const qs = period.preset === 'custom'
    ? (period.customFrom && period.customTo ? `from=${period.customFrom}&to=${period.customTo}` : null)
    : (namedMonthRangeQS(period.preset) ?? `preset=${period.preset}`);

  const load = useCallback(async () => {
    if (!qs) return; // custom picked, one end missing — wait rather than guess
    setBusy(true);
    try {
      const res = await fetch(`/api/quotes-metrics?${qs}${props.siteId ? `&site=${props.siteId}` : ''}`, { cache: 'no-store' });
      if (res.ok) setData(await res.json());
    } catch { /* keep the last figures rather than blanking the panel */ }
    setBusy(false);
  }, [qs, props.siteId]);
  useEffect(() => { void load(); }, [load]);

  const m = data?.metrics ?? null;
  const monthName = (iso: string) =>
    new Date(iso).toLocaleDateString(props.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });

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

      {/* ── SUMMARY PANEL ─────────────────────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-xl p-4 mb-5" data-testid="quotes-summary">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="text-lg font-bold text-ink">Summary</h2>
          <PeriodPicker
            value={period} onChange={setPeriod}
            fyStartMonth={props.fyStartMonth} locale={props.locale} storageKey={PERIOD_KEY}
          />
        </div>

        {/* AWAITING IS A STOCK. It is rendered OUTSIDE the period-dependent block on purpose: a
            period that predates the tenant does not make today's outstanding quotes unknown. */}
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 ${busy ? 'opacity-60' : ''}`}>
          <div className="rounded-lg border border-dashed border-accent p-3" data-testid="tile-awaiting">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted">Awaiting response</span>
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 bg-accent text-white">As of today</span>
            </div>
            <p className="text-2xl font-bold text-ink tabular-nums mt-1" data-testid="awaiting-value">
              {data ? money(data.awaitingPennies) : '—'}
            </p>
            <p className="text-xs text-muted mt-1">
              {data ? `${data.awaitingCount} quote${data.awaitingCount === 1 ? '' : 's'} out now` : ''}
              {data && data.awaitingVerbalCount > 0 ? `, ${data.awaitingVerbalCount} given verbally` : ''}
            </p>
            <p className="text-[11px] text-muted mt-1 italic">What is outstanding right now — the period above does not change it.</p>
          </div>

          {data?.beforeData ? (
            <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-line bg-surface-muted p-3" data-testid="quotes-no-data">
              <p className="text-sm font-semibold text-ink">No records for this period.</p>
              <p className="text-sm text-muted mt-1">
                {data.dataStart
                  ? `Your records begin in ${monthName(data.dataStart)}. Nothing was measured before then, so there are no figures to show — not zero ones.`
                  : 'Nothing has been recorded in GreaseDesk yet, so there is nothing to measure for this period.'}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-line p-3" data-testid="tile-accepted">
                <span className="text-xs font-semibold text-muted">Accepted</span>
                <p className="text-2xl font-bold text-ok tabular-nums mt-1" data-testid="accepted-value">{m ? money(m.acceptedPennies) : '—'}</p>
                <p className="text-xs text-muted mt-1">{m ? `${m.acceptedCount} quote${m.acceptedCount === 1 ? '' : 's'}` : ''}
                  {m && m.acceptedVerbalCount > 0 ? `, ${m.acceptedVerbalCount} verbal` : ''}</p>
                {/* SUBSET, worded so it can never be added to the figure above. */}
                <p className="text-xs text-muted mt-1" data-testid="accepted-booked">
                  {m ? `of which ${m.acceptedBookedCount} ${m.acceptedBookedCount === 1 ? 'is' : 'are'} booked in (${money(m.acceptedBookedPennies)}) — part of the figure above, not extra` : ''}
                </p>
              </div>

              <div className="rounded-lg border border-line p-3" data-testid="tile-declined">
                <span className="text-xs font-semibold text-muted">Declined</span>
                <p className="text-2xl font-bold text-ink tabular-nums mt-1">{m ? money(m.declinedPennies) : '—'}</p>
                <p className="text-xs text-muted mt-1">{m ? `${m.declinedCount} quote${m.declinedCount === 1 ? '' : 's'}, by the date the customer answered` : ''}</p>
              </div>

              <div className="rounded-lg border border-line p-3" data-testid="tile-expired">
                <span className="text-xs font-semibold text-muted">Expired</span>
                <p className="text-2xl font-bold text-warn tabular-nums mt-1">{m ? money(m.expiredPennies) : '—'}</p>
                <p className="text-xs text-muted mt-1">{m ? `${m.expiredCount} lapsed unanswered in this period` : ''}</p>
                <p className="text-[11px] text-muted mt-1 italic">Verbal quotes never expire — nothing was sent, so nothing lapses.</p>
              </div>
            </>
          )}
        </div>

        {!data?.beforeData && m && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div className="rounded-lg border border-line p-3">
              <span className="text-xs font-semibold text-muted">Conversion rate</span>
              <p className="text-2xl font-bold text-ink tabular-nums mt-1" data-testid="conversion-rate">
                {m.conversionPct == null ? '—' : `${m.conversionPct}%`}
              </p>
              <p className="text-xs text-muted mt-1">
                {m.cohortAcceptedCount} of {m.cohortSentCount} quotes SENT in this period were accepted. Verbal quotes have no send date, so they are not in this figure.
              </p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <span className="text-xs font-semibold text-muted">Average days to answer</span>
              <p className="text-2xl font-bold text-ink tabular-nums mt-1" data-testid="avg-days">
                {m.avgDaysToResponse == null ? '—' : m.avgDaysToResponse}
              </p>
              <p className="text-xs text-muted mt-1">
                {m.avgDaysSample > 0 ? `From ${m.avgDaysSample} answered quote${m.avgDaysSample === 1 ? '' : 's'} — sent quotes only, since a verbal quote has no send date.` : 'No answered quotes in this period.'}
              </p>
            </div>
          </div>
        )}

        {/* THE CHART — guarded HERE, before its wrapper, not inside the component. Two slices in a
            row found a block drawing its shell, heading and axes around absent data. */}
        {!data?.beforeData && m && m.series.length > 0 && (
          <div className="mt-4 border-t border-line pt-3" data-testid="quotes-chart">
            <h3 className="text-sm font-semibold text-ink">Quoted vs accepted, by the month the quote was sent</h3>
            <p className="text-xs text-muted mb-2">
              Each bar pair is a COHORT: quotes sent in that month, and how much of that was accepted whenever the answer came.
              The tiles above are dated by when the OUTCOME happened, so the two are bucketed differently by design and will not add up to each other.
            </p>
            <ConversionChart
              series={m.series} money={money}
              labels={{ quoted: 'Quoted', accepted: 'Accepted', incomplete: 'Still open — not had 14 days yet' }}
            />
          </div>
        )}

        {/* THE HISTORY BOUNDARY, said out loud rather than quietly under-reported. */}
        {!data?.beforeData && m && m.historicDatedCount > 0 && (
          <p className="text-[11px] text-muted mt-3 italic" data-testid="history-note">
            {m.historicDatedCount} of the {m.acceptedCount} acceptances in this period predate 5 August 2026 and are dated from the audit trail
            rather than the acceptance record, because the acceptance date was not stored as a field before then. The dates are real; the source is older.
          </p>
        )}
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

export const getServerSideProps: GetServerSideProps<Props> = withI18n(['period'])(async (ctx) => {
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
  const [site, group] = await Promise.all([
    prisma.site.findFirst({ where: { id: siteIds[0] ?? '' }, select: { currency_code: true, locale: true } }),
    // fy_start_month drives the FY labels in the shared picker; ref keys the stored selection so
    // one browser used for two tenants never restores the wrong one.
    prisma.group.findUnique({ where: { id: user.group_id as string }, select: { fy_start_month: true, ref: true } }),
  ]);

  return {
    props: {
      rows, counts, filter, siteId,
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
      fyStartMonth: group?.fy_start_month ?? 4,
      accountRef: group?.ref ?? 'unknown',
    },
  };
}) as GetServerSideProps<Props>;
