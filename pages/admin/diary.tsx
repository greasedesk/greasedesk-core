/**
 * File: pages/admin/diary.tsx
 * Detail-rich diary (light theme). Source of truth = JobCard.start_at/end_at (one object with the
 * card). Each job renders as a BLOCK spanning its hours, laid out in side-by-side sub-columns when
 * jobs overlap (lib/diary-layout). Week view shows the site's OPEN days and NARROWS them to fit —
 * never truncates. Reg flips vertical when a block is squeezed (container query, styles/globals.css).
 * Single-click = peek popover; double-click = open the card. Placement is manager/admin (canManageSite).
 */
import React, { useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';
import { resolveColour, blockTint } from '@/lib/diary-colours';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { layoutOverlap } from '@/lib/diary-layout';
import { formatMoney } from '@/lib/format-money';
import { computeQuoteTotals, poundsToPennies } from '@/lib/quote-totals';

const PX_PER_MIN = 1;

type ResourceCol = { id: string; name: string; type: string; colour: string | null };
type DiaryCard = { id: string; resourceId: string; resourceName: string; resourceColour: string | null; reg: string; customer: string; startAt: string; endAt: string; status: string; valuePennies: number };
type UnscheduledCard = { id: string; reg: string; customer: string };
type DayCol = { date: string; label: string };
type PageProps = {
  siteId: string; siteName: string; view: 'week' | 'day'; anchor: string;
  prev: string; next: string; days: DayCol[];
  resources: ResourceCol[]; cards: DiaryCard[]; unscheduled: UnscheduledCard[];
  openHour: number; closeHour: number; currency: string; locale: string; canManage: boolean;
  noSites?: boolean;
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function dayStartMs(date: string) { return Date.parse(`${date}T00:00:00.000Z`); }
function hhmm(iso: string) { return new Date(iso).toISOString().slice(11, 16); }

export default function DiaryPage(props: PageProps) {
  const { siteId, siteName, view, anchor, prev, next, days, resources, cards, unscheduled, openHour, closeHour, currency, locale, canManage, noSites } = props;
  const { t } = useTranslation('diary');
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  const WIN_MIN = (closeHour - openHour) * 60;
  const HOURS = Array.from({ length: closeHour - openHour + 1 }, (_, i) => openHour + i);

  const [msg, setMsg] = useState<{ text: string; type: 'error' | 'success' } | null>(null);
  const [jobCardId, setJobCardId] = useState('');
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const [date, setDate] = useState(view === 'day' ? anchor : days[0]?.date ?? anchor);
  const [time, setTime] = useState(`${String(openHour).padStart(2, '0')}:00`);
  const [hours, setHours] = useState('2');
  const [peek, setPeek] = useState<{ card: DiaryCard; x: number; y: number } | null>(null);
  const clickTimer = useRef<number | null>(null);

  if (noSites) {
    return (
      <AdminLayout>
        <Head><title>{t('title')} - GreaseDesk</title></Head>
        <div className="bg-surface text-ink rounded-xl border border-line p-8 text-center shadow">{t('noSite')}</div>
      </AdminLayout>
    );
  }

  function segment(c: { startAt: string; endAt: string }, d: string) {
    const winStart = dayStartMs(d) + openHour * 3600000;
    const winEnd = dayStartMs(d) + closeHour * 3600000;
    const s = Math.max(Date.parse(c.startAt), winStart);
    const e = Math.min(Date.parse(c.endAt), winEnd);
    if (e <= s) return null;
    return { top: ((s - winStart) / 60000) * PX_PER_MIN, height: Math.max(18, ((e - s) / 60000) * PX_PER_MIN), s, e };
  }

  function openCard(id: string) { router.push(`/admin/jobcards/${id}`); }
  function onBlockClick(card: DiaryCard, e: React.MouseEvent) {
    const x = e.clientX, y = e.clientY;
    if (clickTimer.current) return;
    clickTimer.current = window.setTimeout(() => { clickTimer.current = null; setPeek({ card, x, y }); }, 200);
  }
  function onBlockDbl(card: DiaryCard) {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    setPeek(null); openCard(card.id);
  }

  async function place(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    if (!jobCardId || !resourceId) { setMsg({ text: t('place.pickBoth'), type: 'error' }); return; }
    const startAt = new Date(`${date}T${time}:00.000Z`);
    const dur = Number(hours);
    if (!Number.isFinite(dur) || dur <= 0) { setMsg({ text: t('place.failed'), type: 'error' }); return; }
    const endAt = new Date(startAt.getTime() + dur * 3600000);
    const res = await fetch('/api/diary', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, resourceId, startAt: startAt.toISOString(), endAt: endAt.toISOString() }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg({ text: data?.message || t('place.failed'), type: 'error' }); return; }
    setMsg({ text: t('place.placed'), type: 'success' }); setJobCardId(''); refresh();
  }

  const columns = view === 'week'
    ? days.map((d) => ({ key: d.date, label: d.label, date: d.date, resourceId: undefined as string | undefined }))
    : resources.map((r) => ({ key: r.id, label: r.name, date: anchor, resourceId: r.id }));

  function Block({ c, top, height, leftPct, widthPct }: { c: DiaryCard; top: number; height: number; leftPct: number; widthPct: number }) {
    const colour = resolveColour(c.resourceColour);
    return (
      <div
        onClick={(e) => onBlockClick(c, e)}
        onDoubleClick={() => onBlockDbl(c)}
        style={{ top, height, left: `${leftPct}%`, width: `calc(${widthPct}% - 3px)`, backgroundColor: blockTint(colour), borderLeft: `3px solid ${colour}` }}
        className="diary-block absolute rounded-md overflow-hidden shadow-sm cursor-pointer select-none"
        title={`${c.reg} · ${c.customer} · ${c.resourceName} · ${hhmm(c.startAt)}–${hhmm(c.endAt)}`}
      >
        <span className="diary-reg block font-semibold text-[11px] text-ink px-1 pt-0.5">{c.reg}</span>
        {view === 'day' && height > 40 && <span className="block text-[10px] text-muted px-1 truncate">{c.customer}</span>}
      </div>
    );
  }

  return (
    <AdminLayout>
      <Head><title>{t('title')} - GreaseDesk</title></Head>

      <div className="bg-surface text-ink rounded-xl border border-line p-4 shadow">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-bold text-ink">{t('title')} — {siteName}</h1>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-line">
              <Link href={`/admin/diary?site=${siteId}&view=week&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'week' ? 'bg-accent text-white' : 'bg-surface-muted text-ink'}`}>{t('week')}</Link>
              <Link href={`/admin/diary?site=${siteId}&view=day&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'day' ? 'bg-accent text-white' : 'bg-surface-muted text-ink'}`}>{t('day')}</Link>
            </div>
            <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${prev}`} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">←</Link>
            <span className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">{view === 'week' ? t('weekOf', { date: days[0]?.date ?? anchor }) : anchor}</span>
            <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${next}`} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">→</Link>
          </div>
        </div>

        {msg && <div className={`p-3 rounded-lg mb-4 text-sm ${msg.type === 'success' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        {canManage && resources.length > 0 && (
          <form onSubmit={place} className="bg-surface-muted border border-line rounded-lg p-3 mb-4 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">{t('place.jobCard')}</label>
              <select value={jobCardId} onChange={(e) => setJobCardId(e.target.value)} className="p-2 bg-surface border border-line rounded text-ink text-sm min-w-[180px]">
                <option value="">{t('place.unscheduled', { count: unscheduled.length })}</option>
                {unscheduled.map((u) => <option key={u.id} value={u.id}>{u.reg} — {u.customer}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">{t('place.resource')}</label>
              <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} className="p-2 bg-surface border border-line rounded text-ink text-sm">
                {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div><label className="block text-xs text-muted mb-1">{t('place.date')}</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="p-2 bg-surface border border-line rounded text-ink text-sm" /></div>
            <div><label className="block text-xs text-muted mb-1">{t('place.start')}</label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="p-2 bg-surface border border-line rounded text-ink text-sm" /></div>
            <div><label className="block text-xs text-muted mb-1">{t('place.hours')}</label><input type="number" step="0.5" min="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className="p-2 bg-surface border border-line rounded text-ink text-sm w-20" /></div>
            <button type="submit" className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm">{t('place.submit')}</button>
          </form>
        )}

        {resources.length === 0 ? (
          <div className="bg-surface-muted border border-line rounded-xl p-8 text-center text-muted">{t('noResources')}</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex min-w-full">
              {/* Time axis */}
              <div className="w-14 shrink-0 pt-7">
                {HOURS.map((h) => (
                  <div key={h} style={{ height: 60 * PX_PER_MIN }} className="text-xs text-muted text-right pr-2 -mt-2">{String(h).padStart(2, '0')}:00</div>
                ))}
              </div>
              {/* Day / resource columns — flex-1 so they narrow to fit; never truncated */}
              <div className="flex-1 flex min-w-0">
                {columns.map((col) => {
                  const colCards = cards.filter((c) => {
                    if (view === 'day' && c.resourceId !== col.resourceId) return false;
                    return !!segment(c, col.date);
                  });
                  const segs = colCards.map((c) => { const sg = segment(c, col.date)!; return { s: sg.s, e: sg.e, top: sg.top, height: sg.height, card: c }; });
                  const placed = layoutOverlap(segs);
                  return (
                    <div key={col.key} className="flex-1 min-w-[46px] border-l border-line">
                      <div className="h-7 text-sm text-ink text-center font-medium truncate px-1">{col.label}</div>
                      <div className="relative bg-surface" style={{ height: WIN_MIN * PX_PER_MIN }}>
                        {HOURS.slice(1).map((h, i) => (
                          <div key={h} style={{ top: (i + 1) * 60 * PX_PER_MIN }} className="absolute left-0 right-0 border-t border-line" />
                        ))}
                        {placed.map((x) => (
                          <Block key={x.card.id} c={x.card} top={x.top} height={x.height} leftPct={(x.col / x.cols) * 100} widthPct={100 / x.cols} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Peek popover (single-click) */}
      {peek && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPeek(null)} />
          <div
            className="fixed z-50 bg-surface border border-line rounded-xl shadow-lg p-3 w-64 text-sm"
            style={{ left: Math.min(peek.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 272), top: Math.min(peek.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200) }}
          >
            <div className="font-semibold text-ink text-base mb-1">{peek.card.reg}</div>
            <div className="space-y-0.5 text-muted">
              <div><span className="text-muted">{t('peek.customer')}: </span><span className="text-ink">{peek.card.customer}</span></div>
              <div><span className="text-muted">{t('peek.lift')}: </span><span className="text-ink">{peek.card.resourceName}</span></div>
              <div><span className="text-muted">{t('peek.time')}: </span><span className="text-ink">{hhmm(peek.card.startAt)}–{hhmm(peek.card.endAt)}</span></div>
              <div><span className="text-muted">{t('peek.status')}: </span><span className="text-ink">{t(`status.${peek.card.status}`)}</span></div>
              <div><span className="text-muted">{t('peek.value')}: </span><span className="text-ink font-medium">{formatMoney(peek.card.valuePennies, { currency, locale })}</span></div>
            </div>
            <Link href={`/admin/jobcards/${peek.card.id}`} className="mt-2 inline-block text-accent hover:underline font-medium">{t('peek.open')} →</Link>
          </div>
        </>
      )}
    </AdminLayout>
  );
}

export const getServerSideProps = withI18n(['diary'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };

  const vis = await getVisibility(user.id as string);
  if (vis.siteIds.length === 0) {
    const today = ymd(new Date());
    return { props: { siteId: '', siteName: '', view: 'week', anchor: today, prev: today, next: today, days: [], resources: [], cards: [], unscheduled: [], openHour: 8, closeHour: 18, currency: 'GBP', locale: 'en-GB', canManage: false, noSites: true } };
  }

  const wanted = (ctx.query.site as string) || user.site_id;
  const resolvedId = wanted && vis.siteIds.includes(wanted) ? wanted : vis.siteIds[0];
  const site = (await prisma.site.findFirst({
    where: { id: resolvedId },
    select: { id: true, site_name: true, open_days: true, open_hour: true, close_hour: true, week_start: true, currency_code: true, locale: true },
  })) as any;
  if (!site) return { redirect: { destination: '/admin/diary', permanent: false } };

  const openDays: number[] = (site.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6]).slice().sort((a: number, b: number) => a - b);
  const openHour: number = site.open_hour ?? 8;
  const closeHour: number = site.close_hour ?? 18;
  const weekStart: number = site.week_start ?? 1;
  const canManage = canManageSite(vis, site.id);

  const view: 'week' | 'day' = ctx.query.view === 'day' ? 'day' : 'week';
  const dateParam = (ctx.query.date as string) || '';
  const anchorObj = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00.000Z`) : new Date(`${ymd(new Date())}T00:00:00.000Z`);
  const anchor = ymd(anchorObj);
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let rangeStart: Date, rangeEnd: Date, days: DayCol[], prev: string, next: string;
  if (view === 'week') {
    const dow = anchorObj.getUTCDay();
    const offset = (dow - weekStart + 7) % 7; // align to the site's start-of-week
    const weekStartObj = new Date(anchorObj.getTime() - offset * 86400000);
    rangeStart = weekStartObj;
    rangeEnd = new Date(weekStartObj.getTime() + 7 * 86400000);
    days = Array.from({ length: 7 }, (_, i) => new Date(weekStartObj.getTime() + i * 86400000))
      .filter((d) => openDays.includes(d.getUTCDay())) // only the site's OPEN days
      .map((d) => ({ date: ymd(d), label: `${DAY_LABELS[d.getUTCDay()]} ${d.getUTCDate()}` }));
    prev = ymd(new Date(anchorObj.getTime() - 7 * 86400000));
    next = ymd(new Date(anchorObj.getTime() + 7 * 86400000));
  } else {
    rangeStart = anchorObj;
    rangeEnd = new Date(anchorObj.getTime() + 86400000);
    days = [{ date: anchor, label: anchor }];
    prev = ymd(new Date(anchorObj.getTime() - 86400000));
    next = ymd(new Date(anchorObj.getTime() + 86400000));
  }

  type ResRow = { id: string; name: string; type: string; colour: string | null };
  const [resourceRows, cardRows, unschedRows] = await Promise.all([
    prisma.resource.findMany({ where: { site_id: site.id, is_active: true }, orderBy: { display_order: 'asc' }, select: { id: true, name: true, type: true, colour: true } }) as Promise<ResRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, resource_id: { not: null }, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: {
        id: true, resource_id: true, start_at: true, end_at: true, status: true, vat_rate: true,
        resource: { select: { name: true, colour: true } },
        vehicle: { select: { registration: true } },
        customer: { select: { name: true } },
        items: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true } },
      },
    }) as Promise<any[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, OR: [{ start_at: null }, { resource_id: null }], archived_at: null },
      orderBy: { created_at: 'desc' },
      select: { id: true, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<any[]>,
  ]);

  const resources: ResourceCol[] = resourceRows.map((r) => ({ id: r.id, name: r.name, type: r.type, colour: r.colour }));
  const num = (d: any) => (d == null ? 0 : Number(d));
  const cards: DiaryCard[] = cardRows.map((c) => {
    // Gross value (incl. VAT) via the shared money chokepoint.
    const totals = computeQuoteTotals(
      (c.items as any[]).map((it) => ({
        item_type: it.item_type, qty: num(it.qty),
        unit_price_pennies: poundsToPennies(num(it.unit_price)), unit_cost_pennies: poundsToPennies(num(it.unit_cost)),
        vatable: num(it.vat_rate) > 0,
      })),
      num(c.vat_rate),
    );
    return {
      id: c.id, resourceId: c.resource_id as string,
      resourceName: c.resource?.name ?? '—', resourceColour: c.resource?.colour ?? null,
      reg: c.vehicle?.registration ?? '—', customer: c.customer?.name ?? '—',
      startAt: (c.start_at as Date).toISOString(), endAt: (c.end_at as Date).toISOString(),
      status: c.status as string, valuePennies: totals.total_pennies,
    };
  });
  const unscheduled: UnscheduledCard[] = unschedRows.map((u) => ({ id: u.id, reg: u.vehicle?.registration ?? '—', customer: u.customer?.name ?? '—' }));

  return { props: { siteId: site.id, siteName: site.site_name, view, anchor, prev, next, days, resources, cards, unscheduled, openHour, closeHour, currency: site.currency_code ?? 'GBP', locale: site.locale ?? 'en-GB', canManage } };
});
