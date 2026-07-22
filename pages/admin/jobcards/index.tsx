/**
 * File: pages/admin/jobcards/index.tsx
 * Slice 1: job-card list for the current tenant.
 *
 * SSR read pattern mirrors pages/admin/settings.tsx: getServerSession → guard →
 * Prisma query scoped to the session's group_id. Never returns another tenant's cards.
 *
 * WIP MODE (?filter=wip): the destination of the dashboard "Work in progress, not invoiced" tile.
 * Server-filtered to exactly the cards that tile counts (lib/wip — the SHARED definition, so the
 * list total always reconciles with the tile), scoped to the same sites, sorted OLDEST FIRST with
 * per-card ex-VAT value + days-open. Gated to admin/SITE_MANAGER (the tile's audience): a user who
 * can't see the tile is bounced to the plain list, so they can't reach the money view by URL.
 */
import React, { useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { onboardingGateRedirect } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { formatMoney } from '@/lib/format-money';
import { wipCardsWhere, wipCardValuePennies, daysOpen, WIP_AGE_DAYS } from '@/lib/wip';

type Stages = {
  details: boolean;
  intake: boolean;
  injob: boolean;
  complete: boolean;
};

type JobCardRow = {
  id: string;
  registration: string;
  customerName: string;
  status: string;
  createdAt: string; // ISO
  stages: Stages;
  invoiceNumber: string | null;
  valuePennies?: number; // WIP mode only — ex-VAT working-draft value (comeback = 0)
  daysOpen?: number;     // WIP mode only
};

// Per-status tabs (ruling 2026-07-10, replaces Current/Completed). Paid includes cards in the
// clearance window (paid_pending is an INVOICE state — the card sits at `paid` through it).
// Statuses without a named tab (invoiced, done, declined, cancelled) appear under All only.
const TABS = ['all', 'draft', 'quoted', 'accepted', 'in_progress', 'paid'] as const;
type Tab = typeof TABS[number];
const TAB_STATUSES: Record<Tab, string[] | null> = {
  all: null,
  draft: ['draft'],
  quoted: ['quoted'],
  accepted: ['accepted'],
  in_progress: ['in_progress'],
  paid: ['paid'],
};
const TAB_LABELS: Record<Tab, string> = { all: 'All', draft: 'Draft', quoted: 'Quoted', accepted: 'Accepted', in_progress: 'In-Progress', paid: 'Paid' };

type WipSummary = { total: number; count: number; ageDays: number; site: string };
type PageProps = {
  cards: JobCardRow[]; noSites: boolean; scopeLabel: string;
  currency: string; locale: string;
  wip: WipSummary | null; // present ⇒ WIP mode
};

const STAGE_LABELS: Array<[keyof Stages, string]> = [
  ['details', 'Job Card'],
  ['intake', 'Intake'],
  ['injob', 'In-Job'],
  ['complete', 'Complete'],
];

function StageBadges({ stages }: { stages: Stages }) {
  return (
    <div className="flex flex-wrap gap-1">
      {STAGE_LABELS.map(([key, label]) => (
        <span
          key={key}
          className={`text-xs px-2 py-0.5 rounded-full border ${
            stages[key]
              ? 'bg-ok-soft text-ok border-line'
              : 'bg-surface-muted text-muted border-line'
          }`}
          title={stages[key] ? `${label}: Done` : `${label}: Pending`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export default function JobCardsListPage({ cards, noSites, scopeLabel, currency, locale, wip }: PageProps) {
  // Default = All (per the six-tab ruling; the named tabs are one click away).
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const money = (p: number) => formatMoney(p, { currency, locale });
  const shown = useMemo(() => {
    const statuses = wip ? null : TAB_STATUSES[tab]; // WIP mode is server-filtered — tabs don't apply
    const needle = q.trim().toLowerCase().replace(/\s+/g, '');
    return cards.filter((c) => {
      if (statuses && !statuses.includes(c.status)) return false;
      if (!needle) return true;
      return (
        c.registration.toLowerCase().replace(/\s+/g, '').includes(needle) ||
        c.customerName.toLowerCase().includes(q.trim().toLowerCase()) ||
        (c.invoiceNumber ?? '').toLowerCase().includes(needle)
      );
    });
  }, [cards, tab, q, wip]);

  const colCount = wip ? 6 : 5;

  return (
    <>
      <Head>
        <title>Job Cards - GreaseDesk</title>
      </Head>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-ink">Job Cards</h1>
          {scopeLabel && <p className="text-sm text-muted mt-0.5">{scopeLabel}</p>}
        </div>
        <Link
          href="/admin/jobcards/new"
          className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm"
        >
          + New Job Card
        </Link>
      </div>

      {/* WIP filter banner: the count + total here are the SERVER totals over the whole filtered set
          — they reconcile with the dashboard tile regardless of any client-side search below. */}
      {wip && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft p-4 mb-4">
          <div className="text-sm">
            <span className="font-semibold text-ink">Work in progress, not invoiced</span>
            <span className="text-muted"> — accepted or in progress, no invoice raised. Oldest first.</span>
            <div className="mt-1 text-ink font-semibold tabular-nums">
              {wip.count} {wip.count === 1 ? 'card' : 'cards'} · {money(wip.total)} <span className="font-normal text-muted">ex-VAT</span>
            </div>
          </div>
          <Link href="/admin/jobcards" className="shrink-0 text-sm font-medium text-accent whitespace-nowrap hover:underline">Clear filter ✕</Link>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        {!wip && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
            {TABS.map((f) => (
              <button key={f} onClick={() => setTab(f)}
                className={`shrink-0 text-sm rounded-lg px-3 py-2 border ${tab === f ? 'bg-accent text-white border-accent font-semibold' : 'bg-surface text-ink border-line hover:bg-surface-muted'}`}>
                {TAB_LABELS[f]}
              </button>
            ))}
          </div>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reg, customer or invoice number…"
          className="sm:ml-auto sm:w-72 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm focus:ring-accent focus:border-accent" />
      </div>

      {/* overflow-x-auto (demo hardening 2026-07-14): the table SCROLLS inside its own container on a
          narrow screen — it never pushes the page wider or clips columns. Matches the invoices tables. */}
      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        <table className="w-full text-left text-sm text-ink">
          <thead className="bg-surface-muted text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-3">Reg</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Stages</th>
              {wip
                ? <>
                    <th className="px-4 py-3">Days open</th>
                    <th className="px-4 py-3 text-right">Value (ex-VAT)</th>
                  </>
                : <th className="px-4 py-3">Created</th>}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-muted">
                  {noSites
                    ? "You're not currently assigned to a location — contact your admin."
                    : cards.length === 0
                      ? (wip ? 'No work in progress — every accepted/in-progress job has been invoiced.' : 'No job cards yet. Create the first one.')
                      : 'Nothing matches this tab or search.'}
                </td>
              </tr>
            )}
            {shown.map((c) => {
              const aged = wip && (c.daysOpen ?? 0) >= (wip?.ageDays ?? WIP_AGE_DAYS);
              return (
                <tr key={c.id} className="border-t border-line hover:bg-surface-muted">
                  <td className="px-4 py-3 font-semibold">
                    <Link href={`/admin/jobcards/${c.id}?from=list`} className="text-accent hover:underline">
                      {c.registration}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{c.customerName}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface-muted border border-line capitalize">
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StageBadges stages={c.stages} />
                  </td>
                  {wip ? (
                    <>
                      <td className={`px-4 py-3 tabular-nums ${aged ? 'text-warn font-semibold' : 'text-muted'}`}>
                        {c.daysOpen} {c.daysOpen === 1 ? 'day' : 'days'}{aged ? ' ⚠' : ''}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(c.valuePennies ?? 0)}</td>
                    </>
                  ) : (
                    <td className="px-4 py-3 text-muted">
                      {new Date(c.createdAt).toLocaleDateString('en-GB')}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {wip && shown.length > 0 && (
            <tfoot className="border-t border-line bg-surface-muted text-xs uppercase text-muted">
              <tr>
                <td className="px-4 py-3" colSpan={4}>{shown.length === wip.count ? 'Total' : `Showing ${shown.length} of ${wip.count}`}</td>
                <td className="px-4 py-3"></td>
                <td className="px-4 py-3 text-right tabular-nums text-ink font-semibold normal-case">
                  {shown.length === wip.count ? money(wip.total) : money(shown.reduce((a, c) => a + (c.valuePennies ?? 0), 0))}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  // Root onboarding gate (item-13) — replaces the old !site_id → setup-location leaf patch.
  const onboard = await onboardingGateRedirect(user.group_id);
  if (onboard) return { redirect: { destination: onboard, permanent: false } };

  const vis = await getVisibility(user.id as string); // role/assignment site visibility

  // WIP MODE gate: the money view is the dashboard tile's audience (admin/SITE_MANAGER). A user who
  // cannot see the tile is bounced to the plain list — they can't reach the money view by URL.
  const wipMode = ctx.query.filter === 'wip';
  if (wipMode && !(vis.isAdmin || vis.role === 'SITE_MANAGER')) {
    return { redirect: { destination: '/admin/jobcards', permanent: false } };
  }

  const fmtSite = vis.primarySiteId ?? vis.siteIds[0] ?? null;
  const fmt = fmtSite ? ((await prisma.site.findUnique({ where: { id: fmtSite }, select: { currency_code: true, locale: true } })) as { currency_code: string; locale: string } | null) : null;
  const currency = fmt?.currency_code ?? 'GBP';
  const locale = fmt?.locale ?? 'en-GB';

  if (vis.siteIds.length === 0) {
    return { props: { cards: [], noSites: true, scopeLabel: '', currency, locale, wip: wipMode ? { total: 0, count: 0, ageDays: WIP_AGE_DAYS, site: '' } : null } };
  }

  // Location scope from ?site: "all" (multi-site only) shows every accessible site; a valid site id
  // filters to it; otherwise default to the PRIMARY location. Forced out-of-scope ?site falls back
  // to primary — a mechanic can never pull another location's cards by hand-typing the URL. WIP-mode
  // links carry the SAME site the dashboard used, so the list scope matches the tile's scope.
  const raw = typeof ctx.query.site === 'string' ? ctx.query.site : '';
  const isAll = raw === 'all' && vis.siteIds.length > 1;
  const sid = isAll ? null : (raw && raw !== 'all' && vis.siteIds.includes(raw) ? raw : (vis.primarySiteId ?? vis.siteIds[0]));
  const scopeIds = isAll ? vis.siteIds : [sid as string];

  const rows = (await prisma.jobCard.findMany({
    where: wipMode ? wipCardsWhere(scopeIds) : { site_id: isAll ? { in: vis.siteIds } : (sid as string) },
    orderBy: { created_at: wipMode ? 'asc' : 'desc' }, // WIP: oldest first — the aged cards are the problem
    include: {
      customer: { select: { name: true } },
      vehicle: { select: { registration: true } },
      invoice: { select: { invoice_number: true } },
    },
  })) as any[];

  let scopeLabel = 'All locations';
  if (!isAll && sid) {
    const s = (await prisma.site.findUnique({ where: { id: sid }, select: { site_name: true } })) as { site_name: string } | null;
    scopeLabel = s?.site_name ?? '';
  }

  const now = new Date();
  let wipTotal = 0;
  const cards: JobCardRow[] = rows.map((r: any) => {
    const base: JobCardRow = {
      id: r.id,
      registration: r.vehicle?.registration ?? '—',
      customerName: r.customer?.name ?? '—',
      status: r.status,
      createdAt: r.created_at.toISOString(),
      invoiceNumber: r.invoice?.invoice_number ?? null,
      stages: {
        details: r.stage_details_done,
        intake: r.stage_intake_done,
        injob: r.stage_injob_done,
        complete: r.stage_complete_done,
      },
    };
    if (wipMode) {
      // Value + count from THE shared chokepoint — identical to the tile's arithmetic by construction.
      const v = wipCardValuePennies(r);
      wipTotal += v;
      base.valuePennies = v;
      base.daysOpen = daysOpen(r.created_at, now);
    }
    return base;
  });

  return {
    props: {
      cards, noSites: false, scopeLabel, currency, locale,
      wip: wipMode ? { total: wipTotal, count: cards.length, ageDays: WIP_AGE_DAYS, site: (isAll ? 'all' : (sid as string)) } : null,
    },
  };
};
