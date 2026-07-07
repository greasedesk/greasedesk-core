/**
 * File: pages/admin/diary.tsx
 * Detail-rich diary (light theme). Source of truth = JobCard.start_at/end_at. Jobs render as blocks
 * laid out in overlap sub-columns (lib/diary-layout); week shows the site's OPEN days and narrows.
 * Two-way seam: single-click block = peek, double-click = open card; and CREATE on empty space —
 * click (1h) or drag (range, 15-min snap) opens a dialogue to add a job card (scheduled) or a note.
 * DiaryNotes render visually distinct from jobs. Create/place is manager/admin (canManageSite).
 */
import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { resolveColour, blockTint, RESOURCE_PALETTE } from '@/lib/diary-colours';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { getTenantPermissions, canCreateDiaryEntry, financeVisibility } from '@/lib/permissions';
import { getTenantVat } from '@/lib/tenant-vat';
import { withI18n } from '@/lib/gssp-i18n';
import { layoutOverlap } from '@/lib/diary-layout';
import { formatMoney } from '@/lib/format-money';
import { normalizeReg, normalizeVin } from '@/lib/vehicle-identity';
import { mileageError, vinWarn, phoneWarn, emailWarn, normalizePhone } from '@/lib/quick-validate';
import { computeQuoteTotals, poundsToPennies } from '@/lib/quote-totals';
import { computeFootprint, parseBreaks, Segment, Break } from '@/lib/occupancy';

const PX_PER_MIN = 1;

type ResourceCol = { id: string; name: string; type: string; colour: string | null };
type DiaryCard = { id: string; resourceId: string; resourceName: string; resourceColour: string | null; reg: string; customer: string; serviceSummary: string; services: string[]; startAt: string; endAt: string; status: string; valuePennies: number; segments: Segment[] };
type DiaryNoteView = { id: string; title: string; resourceId: string | null; colour: string | null; startAt: string; endAt: string };
type DayCol = { date: string; label: string };
type DiaryView = 'day' | 'week' | 'month' | 'year';
type PageProps = {
  siteId: string; siteName: string; view: DiaryView; anchor: string;
  prev: string; next: string; days: DayCol[];
  resources: ResourceCol[]; cards: DiaryCard[]; notes: DiaryNoteView[];
  openHour: number; closeHour: number; breaks: Break[]; currency: string; locale: string; canManage: boolean;
  weekStart: number; today: string;
  finance: FinanceProps;
  noSites?: boolean;
};
type FinanceProps = { canSeeValues: boolean; canSeeMargin: boolean; vatRegistered: boolean; bookedPennies: number; marginPennies: number; days: Record<string, { bookedPennies: number; marginPennies: number }> };

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function dayStartMs(date: string) { return Date.parse(`${date}T00:00:00.000Z`); }
function hhmm(iso: string) { return new Date(iso).toISOString().slice(11, 16); }
const pad = (n: number) => String(n).padStart(2, '0');
const snap15 = (min: number) => Math.round(min / 15) * 15;
const menuBtn = 'w-full text-left px-3 py-2.5 hover:bg-surface-muted text-ink';
const HOUR_OPTS = Array.from({ length: 16 }, (_, i) => (i + 1) * 0.5); // 0.5 … 8.0 hrs

// ---- Dynamic mini-month day-picker (module scope so state survives parent re-renders) ----
// Clicking a day jumps the diary to it (day view → that day; week view → that day's week — SSR derives
// the week from the date param). ‹ › page the DISPLAYED month; Today jumps to the real today.
function DayPicker({ siteId, view, anchor, today, weekStart, locale, t, onClose }: {
  siteId: string; view: string; anchor: string; today: string; weekStart: number; locale: string;
  t: (k: string, o?: any) => string; onClose: () => void;
}) {
  const router = useRouter();
  const a = new Date(`${anchor}T00:00:00.000Z`);
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: a.getUTCFullYear(), m: a.getUTCMonth() });
  const go = (dateStr: string) => { router.push(`/admin/diary?site=${siteId}&view=${view}&date=${dateStr}`); onClose(); };

  const first = new Date(Date.UTC(ym.y, ym.m, 1));
  const lead = (first.getUTCDay() - weekStart + 7) % 7;
  const gridStart = new Date(first.getTime() - lead * 86400000);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getTime() + i * 86400000));
  const dow = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const dowLabel = (d: number) => new Date(Date.UTC(2023, 0, 1 + d)).toLocaleDateString(locale, { weekday: 'narrow', timeZone: 'UTC' });
  const monthLabel = first.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (delta: number) => setYm(({ y, m }) => { const d = new Date(Date.UTC(y, m + delta, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; });

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 mt-1 z-40 w-72 bg-surface border border-line rounded-xl shadow-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <button aria-label={t('prev')} onClick={() => shift(-1)} className="px-2 py-1 rounded-md hover:bg-surface-muted text-ink">‹</button>
          <div className="text-sm font-semibold text-ink">{monthLabel}</div>
          <button aria-label={t('next')} onClick={() => shift(1)} className="px-2 py-1 rounded-md hover:bg-surface-muted text-ink">›</button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {dow.map((d) => <div key={d} className="text-center text-[11px] text-muted font-medium py-1">{dowLabel(d)}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((c) => {
            const ds = ymd(c);
            const inMonth = c.getUTCMonth() === ym.m;
            const isToday = ds === today;
            const isSel = ds === anchor;
            const base = 'h-9 rounded-full text-sm flex items-center justify-center';
            const tone = isSel ? 'bg-accent text-white font-semibold'
              : isToday ? 'ring-2 ring-accent text-ink font-semibold'
              : inMonth ? 'text-ink hover:bg-surface-muted' : 'text-muted/50 hover:bg-surface-muted';
            return <button key={ds} onClick={() => go(ds)} className={`${base} ${tone}`}>{c.getUTCDate()}</button>;
          })}
        </div>
        <div className="mt-2 pt-2 border-t border-line flex justify-center">
          <button onClick={() => go(today)} className="text-sm text-accent hover:underline font-medium">{t('todayBtn')}</button>
        </div>
      </div>
    </>
  );
}

export default function DiaryPage(props: PageProps) {
  const { siteId, siteName, view, anchor, prev, next, days, resources, cards, notes, openHour, closeHour, breaks, currency, locale, canManage, weekStart, today, finance, noSites } = props;
  const { t } = useTranslation('diary');
  // Runtime "Show values" toggle — hides already-permitted money ("turn the screen to the customer").
  // The permission gates what's SENT; this only hides what was sent. Persisted per browser.
  const hasFinance = finance.canSeeValues || finance.canSeeMargin;
  const [showValues, setShowValues] = useState(true);
  useEffect(() => { try { setShowValues(localStorage.getItem('gd-diary-show-values') !== '0'); } catch {} }, []);
  const toggleValues = () => setShowValues((v) => { const n = !v; try { localStorage.setItem('gd-diary-show-values', n ? '1' : '0'); } catch {} return n; });
  const showMoney = hasFinance && showValues;
  // "(Ex-VAT)" only for VAT-registered tenants — for a non-registered garage there's no VAT, so their
  // prices ARE their revenue and the label would be meaningless. Money helper with the conditional label.
  const exVatSuffix = finance.vatRegistered ? ` ${t('finance.exVat')}` : '';
  const money = (pennies: number) => formatMoney(pennies, { currency, locale });
  // Week view shows per-day totals under each day header → taller header (axis spacer must match).
  const showDayTotals = view === 'week' && showMoney;
  const headH = showDayTotals ? 'h-12' : 'h-7';
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  // STAGE 1 — the grid now spans the FULL 24h day (00:00–24:00); it scrolls and lands on the working
  // day. Blocks/lunch/gridlines position by absolute minute-of-midnight. The booking ENGINE is unchanged
  // — footprints still live inside working hours; out-of-hours is display space only.
  const DAY_MIN = 24 * 60;                                    // 1440 — full day height in px (PX_PER_MIN=1)
  const HOURS = Array.from({ length: 25 }, (_, i) => i);      // 0..24 (labels + gridlines)
  // Resting window: working hours + ~1h either side (e.g. 09–18 → shows 08:00–19:00). The grid is still
  // fully scrollable to 00:00/24:00 — this only sets how much is visible at rest.
  const REST_MIN = Math.min(DAY_MIN, (closeHour - openHour + 2) * 60);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Land on the working day: 09:00 (open) near the top with ~1h of pre-open context (08:00) above it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, (openHour - 1) * 60 * PX_PER_MIN);
  }, [openHour, view, anchor]);
  // MOBILE DEFAULT = Day. Only when the URL carries NO explicit view (the URL stays the single view-
  // state source) and the viewport is under the tablet breakpoint. One replace on first mobile visit.
  useEffect(() => {
    if (!router.isReady || noSites) return;
    if (router.query.view === undefined && typeof window !== 'undefined' && window.innerWidth < 768) {
      router.replace(`/admin/diary?site=${siteId}&view=day&date=${anchor}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  const [peek, setPeek] = useState<{ card: DiaryCard; x: number; y: number } | null>(null);
  // Right-click / long-press context menu. Empty-space form: {date, resourceId?, atMin}. Booking form: {card}.
  const [menu, setMenu] = useState<{ x: number; y: number; date?: string; resourceId?: string; atMin?: number; card?: DiaryCard } | null>(null);
  const [create, setCreate] = useState<{ date: string; startAt: string; resourceId?: string; mode: 'job' | 'note'; pickWhen?: boolean } | null>(null);
  const [move, setMove] = useState<{ card: DiaryCard } | null>(null);
  const [editNote, setEditNote] = useState<DiaryNoteView | null>(null);
  const clickTimer = useRef<number | null>(null);
  const pressTimer = useRef<number | null>(null);

  if (noSites) {
    return (
      <>
        <Head><title>{t('title')} - GreaseDesk</title></Head>
        <div className="bg-surface text-ink rounded-xl border border-line p-8 text-center shadow">{t('noSite')}</div>
      </>
    );
  }

  function box(s: number, e: number, winStart: number) {
    if (e <= s) return null;
    return { top: ((s - winStart) / 60000) * PX_PER_MIN, height: Math.max(18, ((e - s) / 60000) * PX_PER_MIN), s, e };
  }
  // ALL footprint segments a card occupies on this day → one block each. A lunch-split day yields two
  // (morning + afternoon), so nothing is concealed. Notes (no segments) keep the single raw-clamp.
  function segmentsForDay(c: { startAt: string; endAt: string; segments?: Segment[] }, d: string) {
    // Full-day window (midnight→midnight). Blocks position by minute-of-midnight; the engine keeps
    // footprints inside working hours, so nothing spills past the working band anyway.
    const winStart = dayStartMs(d);
    const winEnd = dayStartMs(d) + DAY_MIN * 60000;
    const out: NonNullable<ReturnType<typeof box>>[] = [];
    if (c.segments) {
      for (const sg of c.segments) {
        const ss = Date.parse(sg.startISO), se = Date.parse(sg.endISO);
        if (se > winStart && ss < winEnd) { const b = box(Math.max(ss, winStart), Math.min(se, winEnd), winStart); if (b) out.push(b); }
      }
      return out;
    }
    const b = box(Math.max(Date.parse(c.startAt), winStart), Math.min(Date.parse(c.endAt), winEnd), winStart);
    return b ? [b] : [];
  }
  const minToISO = (date: string, min: number) => `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00.000Z`;

  // Truthful time label from the footprint. Same-day (1 segment) → plain range. Wrapped/multi-day
  // (>1 segment) → duration in working-hours + start→end WITH weekday, so it never reads as a short
  // same-day job or as continuous clock-time. Derived from the footprint the card already carries.
  const dowTime = (iso: string) => `${new Date(iso).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })} ${hhmm(iso)}`;
  function timeLabel(c: { startAt: string; endAt: string; segments?: Segment[] }) {
    const segs = c.segments ?? [];
    if (segs.length <= 1) return `${hhmm(c.startAt)}–${hhmm(c.endAt)}`;
    const mins = segs.reduce((s, sg) => s + (Date.parse(sg.endISO) - Date.parse(sg.startISO)) / 60000, 0);
    const hrs = Math.round(mins / 30) / 2; // working-hours, nearest half-hour
    return t('peek.wrapped', { h: hrs, start: dowTime(c.startAt), end: dowTime(c.endAt) });
  }

  const cardHref = (id: string) => `/admin/jobcards/${id}?from=diary&site=${siteId}&view=${view}&date=${anchor}`;
  function openCard(id: string) { router.push(cardHref(id)); }
  function onBlockClick(card: DiaryCard, e: React.MouseEvent) {
    e.stopPropagation();
    const x = e.clientX, y = e.clientY;
    if (clickTimer.current) return;
    clickTimer.current = window.setTimeout(() => { clickTimer.current = null; setPeek({ card, x, y }); }, 200);
  }
  function onBlockDbl(card: DiaryCard, e: React.MouseEvent) {
    e.stopPropagation();
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    setPeek(null); openCard(card.id);
  }

  // ---- context menu (right-click desktop / long-press mobile) — replaces drag-to-create ----
  const cancelPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  // y is px from the top of the 24h body = minute-of-midnight. Snap to 15; clamp within the day.
  const atMinFromY = (y: number) => snap15(Math.max(0, Math.min(Math.round(y), DAY_MIN - 15)));
  function openEmptyMenu(col: { date: string; resourceId?: string }, clientX: number, clientY: number, y: number) {
    if (!canManage) return;
    setPeek(null); setMenu({ x: clientX, y: clientY, date: col.date, resourceId: col.resourceId, atMin: atMinFromY(y) });
  }
  function onColContext(col: { date: string; resourceId?: string }, e: React.MouseEvent) {
    if (!canManage) return;
    e.preventDefault(); e.stopPropagation();
    openEmptyMenu(col, e.clientX, e.clientY, e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top);
  }
  function onColTouchStart(col: { date: string; resourceId?: string }, e: React.TouchEvent) {
    if (!canManage) return;
    const tch = e.touches[0]; const y = tch.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const cx = tch.clientX, cy = tch.clientY;
    pressTimer.current = window.setTimeout(() => { pressTimer.current = null; openEmptyMenu(col, cx, cy, y); }, 500);
  }
  // Y within the column body (a block's offsetParent), so "Book a job here" seeds the clicked time even
  // when the click landed on a booking that fills the column.
  const bodyY = (el: HTMLElement, clientY: number) => { const body = el.offsetParent as HTMLElement | null; return body ? clientY - body.getBoundingClientRect().top : 0; };
  function onBlockMenu(card: DiaryCard, col: { date: string; resourceId?: string }, e: React.MouseEvent) {
    if (!canManage) { e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    setPeek(null); setMenu({ x: e.clientX, y: e.clientY, card, date: col.date, resourceId: col.resourceId, atMin: atMinFromY(bodyY(e.currentTarget as HTMLElement, e.clientY)) });
  }
  function onBlockLongPress(card: DiaryCard, col: { date: string; resourceId?: string }, e: React.TouchEvent) {
    if (!canManage) return;
    const tch = e.touches[0]; const cx = tch.clientX, cy = tch.clientY; const y = bodyY(e.currentTarget as HTMLElement, cy);
    pressTimer.current = window.setTimeout(() => { pressTimer.current = null; setPeek(null); setMenu({ x: cx, y: cy, card, date: col.date, resourceId: col.resourceId, atMin: atMinFromY(y) }); }, 500);
  }
  async function unbook(card: DiaryCard) { setMenu(null); await fetch(`/api/diary?jobCardId=${card.id}`, { method: 'DELETE' }); refresh(); }

  const columns = view === 'week'
    ? days.map((d) => ({ key: d.date, label: d.label, date: d.date, resourceId: undefined as string | undefined }))
    : resources.map((r) => ({ key: r.id, label: r.name, date: anchor, resourceId: r.id }));

  // Day-level notes (no lift) shown as a banner strip in day view.
  const dayLevelNotes = view === 'day' ? notes.filter((n) => !n.resourceId && segmentsForDay(n, anchor).length > 0) : [];

  // MOBILE day list: the day's cards + timed (lift) notes, time-sorted. A vertical list makes
  // concurrent bookings stack card-above-card by construction — the grid's layoutOverlap column
  // packing has no role here. Same server-gated data; nothing re-fetched.
  const listItems = view === 'day'
    ? ([
        ...cards.map((c) => ({ kind: 'job' as const, at: Date.parse(c.startAt), card: c })),
        ...notes.filter((n) => !!n.resourceId).map((n) => ({ kind: 'note' as const, at: Date.parse(n.startAt), note: n })),
      ].sort((a, b) => a.at - b.at))
    : [];
  // Swipe left/right on the list = next/prev day (Apple-calendar-style). Threshold beats scroll noise.
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const onListTouchStart = (e: React.TouchEvent) => { const t0 = e.touches[0]; swipeRef.current = { x: t0.clientX, y: t0.clientY }; };
  const onListTouchEnd = (e: React.TouchEvent) => {
    const s = swipeRef.current; swipeRef.current = null;
    if (!s) return;
    const t0 = e.changedTouches[0];
    const dx = t0.clientX - s.x, dy = t0.clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 80) return; // too short / mostly vertical (a scroll)
    router.push(`/admin/diary?site=${siteId}&view=day&date=${dx < 0 ? next : prev}`);
  };

  type Item = { s: number; e: number; top: number; height: number; kind: 'job'; card: DiaryCard } | { s: number; e: number; top: number; height: number; kind: 'note'; note: DiaryNoteView };

  function JobBlock({ c, col, top, height, leftPct, widthPct }: { c: DiaryCard; col: { date: string; resourceId?: string }; top: number; height: number; leftPct: number; widthPct: number }) {
    const colour = resolveColour(c.resourceColour);
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => onBlockClick(c, e)}
        onDoubleClick={(e) => onBlockDbl(c, e)}
        onContextMenu={(e) => onBlockMenu(c, col, e)}
        onTouchStart={(e) => onBlockLongPress(c, col, e)}
        onTouchEnd={cancelPress}
        onTouchMove={cancelPress}
        style={{ top, height, left: `${leftPct}%`, width: `calc(${widthPct}% - 3px)`, backgroundColor: blockTint(colour), borderLeft: `3px solid ${colour}` }}
        className="diary-block absolute rounded-md overflow-hidden shadow-sm cursor-pointer select-none"
        title={`${c.reg} · ${c.customer}${c.serviceSummary ? ` · ${c.serviceSummary}` : ''} · ${c.resourceName} · ${timeLabel(c)}`}
      >
        <span className="diary-reg block font-semibold text-[11px] text-ink px-1 pt-0.5 truncate">{c.reg}</span>
        {/* Day view wraps the customer + service lines to fit the block height (clipped by the block's
            overflow-hidden — as many wrapped lines as fit, clip the rest). Week view stays single-line. */}
        {height > 40 && <span className={`block text-[10px] text-muted px-1 ${view === 'day' ? 'whitespace-normal break-words leading-tight' : 'truncate'}`}>{c.customer}</span>}
        {/* Day view lists ALL service titles, one per line (wraps + clips to block height). */}
        {view === 'day' && c.services.length > 0 && height > 54 && c.services.map((s, i) => (
          <span key={i} className="block text-[10px] text-ink/80 px-1 whitespace-normal break-words leading-tight">{s}</span>
        ))}
        {/* Per-block value — only if the SERVER sent it (permitted) AND the runtime toggle is on. */}
        {showMoney && finance.canSeeValues && height > 28 && <span className={`block text-[10px] font-semibold px-1 tabular-nums ${c.valuePennies < 0 ? 'text-danger' : 'text-ink'}`}>{formatMoney(c.valuePennies, { currency, locale })}</span>}
      </div>
    );
  }
  function NoteBlock({ n, top, height, leftPct, widthPct }: { n: DiaryNoteView; top: number; height: number; leftPct: number; widthPct: number }) {
    const colour = n.colour || '#94a3b8';
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); if (canManage) setEditNote(n); }}
        style={{ top, height, left: `${leftPct}%`, width: `calc(${widthPct}% - 3px)`, borderColor: colour, cursor: canManage ? 'pointer' : 'default' }}
        className="diary-block absolute rounded-md overflow-hidden bg-surface-muted border-2 border-dashed select-none"
        title={`${t('note.tag')}: ${n.title} · ${hhmm(n.startAt)}–${hhmm(n.endAt)}`}
      >
        <span className="block text-[9px] uppercase tracking-wide text-muted px-1 pt-0.5">{t('note.tag')}</span>
        <span className="diary-reg block text-[11px] italic text-ink px-1">{n.title}</span>
      </div>
    );
  }

  // Dynamic headers from the anchor (UTC so they match the SSR date math, not the browser's TZ).
  const anchorUTC = new Date(`${anchor}T00:00:00.000Z`);
  const monthLabel = anchorUTC.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dateLong = anchorUTC.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const weekdayLong = anchorUTC.toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' });
  const yearLabel = String(anchorUTC.getUTCFullYear());
  const pillLabel = view === 'week' ? t('weekOf', { date: days[0]?.date ?? anchor })
    : view === 'month' ? monthLabel
    : view === 'year' ? yearLabel
    : dateLong;
  const isRevenueView = view === 'month' || view === 'year';

  return (
    <>
      <Head><title>{t('title')} - GreaseDesk</title></Head>

      <div className="bg-surface text-ink rounded-xl border border-line p-4 shadow">
        {/* DESKTOP toolbar (Outlook/Apple-style): title left, the four-way view toggle centre-top,
            and ‹ Today › lower-right. Month/Year are revenue-view placeholders (see below). */}
        <div className="hidden md:flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold text-ink">{t('title')} — {siteName}</h1>
          <div className="flex-1 flex justify-center">
            <div className="flex rounded-lg overflow-hidden border border-line">
              {(['day', 'week', 'month', 'year'] as const).map((v) => (
                <Link key={v} href={`/admin/diary?site=${siteId}&view=${v}&date=${anchor}`}
                  className={`shrink-0 whitespace-nowrap px-4 py-1.5 text-sm ${view === v ? 'bg-accent text-white' : 'bg-surface-muted text-ink hover:bg-surface'}`}>
                  {t(v === 'day' ? 'day' : v)}
                </Link>
              ))}
            </div>
          </div>
          {/* right-side spacer roughly balancing the title so the toggle sits near centre */}
          <div className="w-40" aria-hidden />
        </div>
        <div className="hidden md:flex justify-end items-center gap-2 mb-3">
          <div className="relative">
            <button onClick={() => setPickerOpen((o) => !o)} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink hover:bg-surface">{pillLabel}</button>
            {pickerOpen && (
              <DayPicker siteId={siteId} view={view} anchor={anchor} today={today} weekStart={weekStart} locale={locale} t={t} onClose={() => setPickerOpen(false)} />
            )}
          </div>
          <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${prev}`} aria-label={t('prev')} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">←</Link>
          <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${today}`} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink hover:bg-surface">{t('todayBtn')}</Link>
          <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${next}`} aria-label={t('next')} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">→</Link>
        </div>

        {/* MOBILE toolbar — unchanged two-line layout: (1) Week/Day toggle, (2) ‹ date › + Add booking. */}
        <div className="md:hidden mb-3">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <h1 className="text-2xl font-bold text-ink">{t('title')} — {siteName}</h1>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex shrink-0 self-start rounded-lg overflow-hidden border border-line">
              <Link href={`/admin/diary?site=${siteId}&view=week&date=${anchor}`} className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-sm ${view === 'week' ? 'bg-accent text-white' : 'bg-surface-muted text-ink'}`}>{t('week')}</Link>
              <Link href={`/admin/diary?site=${siteId}&view=day&date=${anchor}`} className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-sm ${view === 'day' ? 'bg-accent text-white' : 'bg-surface-muted text-ink'}`}>{t('day')}</Link>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${prev}`} aria-label={t('prev')} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">←</Link>
                <div className="relative">
                  <button onClick={() => setPickerOpen((o) => !o)} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink hover:bg-surface">{pillLabel}</button>
                  {pickerOpen && (
                    <DayPicker siteId={siteId} view={view} anchor={anchor} today={today} weekStart={weekStart} locale={locale} t={t} onClose={() => setPickerOpen(false)} />
                  )}
                </div>
                <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${next}`} aria-label={t('next')} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">→</Link>
              </div>
              {/* Mobile-only. Opens the SAME CreateDialog/create path as the grid gesture, blank: date
                  pre-set to the viewed day, no default lift/time (pickWhen). */}
              {canManage && (
                <button onClick={() => setCreate({ date: anchor, startAt: '', mode: 'job', pickWhen: true })}
                  className="shrink-0 text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-1.5">
                  {t('addBooking')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Header — Outlook-style, dynamic from the anchor. WEEK: month ("June 2026", where dates are
            less prominent). DAY: the full date + weekday only (the month header would be redundant). */}
        <div className="text-center mb-4">
          {view === 'week' || view === 'month' ? (
            <div className="text-xl font-semibold text-ink tracking-tight">{monthLabel}</div>
          ) : view === 'year' ? (
            <div className="text-xl font-semibold text-ink tracking-tight">{yearLabel}</div>
          ) : (
            <div>
              <div className="text-lg font-bold text-ink">{dateLong}</div>
              <div className="text-sm text-muted">{weekdayLong}</div>
            </div>
          )}
        </div>

        {/* Financial glance — only rendered for users the SERVER permitted (numbers omitted otherwise).
            The "Show values" toggle hides them at runtime ("turn the screen to the customer"). */}
        {hasFinance && !isRevenueView && (
          // hidden below the tablet breakpoint — the Booked/Margin/Show-values panel is a large-screen
          // detail (per-block values on the grid stay as-is; that call comes with the day-list redesign).
          <div className="hidden md:flex flex-wrap items-center justify-between gap-3 mb-4 bg-surface-muted border border-line rounded-xl px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              {showMoney && finance.canSeeValues && (
                <span><span className="text-muted">{t('finance.booked')}: </span><span className="text-ink font-semibold tabular-nums">{money(finance.bookedPennies)}{exVatSuffix}</span></span>
              )}
              {showMoney && finance.canSeeMargin && (
                <span><span className="text-muted">{t('finance.margin')}: </span><span className={`font-semibold tabular-nums ${finance.marginPennies < 0 ? 'text-danger' : 'text-ink'}`}>{money(finance.marginPennies)}{exVatSuffix}</span></span>
              )}
              {!showValues && <span className="text-muted italic">{t('finance.hidden')}</span>}
            </div>
            <button onClick={toggleValues} role="switch" aria-checked={showValues} className="shrink-0 flex items-center gap-2 text-sm text-ink">
              <span className="text-muted">{t('finance.showValues')}</span>
              <span className={`w-11 h-6 rounded-full flex items-center transition-colors ${showValues ? 'bg-accent justify-end' : 'bg-surface border border-line justify-start'}`}>
                <span className="w-5 h-5 mx-0.5 rounded-full bg-white shadow" />
              </span>
            </button>
          </div>
        )}

        {isRevenueView ? (
          /* Month/Year are REVENUE views, not booking calendars: they will show the period's aggregate
             revenue from the same paid-ledger the dashboard reads — which requires the invoice artifact
             to exist first. Until then they render this labelled placeholder and must NOT display
             quoted-pipeline figures as if they were revenue. */
          <div className="bg-surface-muted border border-line rounded-xl p-12 text-center">
            <div className="text-lg font-semibold text-ink mb-1">{t('revenue.placeholderTitle')}</div>
            <p className="text-sm text-muted">{t('revenue.placeholderBody')}</p>
          </div>
        ) : resources.length === 0 ? (
          <div className="bg-surface-muted border border-line rounded-xl p-8 text-center text-muted">{t('noResources')}</div>
        ) : (
          <>
            {/* Day-level notes banner (day view) */}
            {dayLevelNotes.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                <span className="text-xs uppercase text-muted self-center">{t('note.dayNotes')}:</span>
                {dayLevelNotes.map((n) => (
                  <span key={n.id} onDoubleClick={() => { if (canManage) setEditNote(n); }}
                    style={{ borderColor: n.colour || '#94a3b8', cursor: canManage ? 'pointer' : 'default' }}
                    className="text-xs px-2 py-1 rounded-md bg-surface-muted border-2 border-dashed">
                    <span className="italic text-ink">{n.title}</span> <span className="text-muted">{hhmm(n.startAt)}–{hhmm(n.endAt)}</span>
                  </span>
                ))}
              </div>
            )}
            {/* MOBILE DAY LIST (<md, day view only): full-width stacked cards on a vertical time axis —
                concurrent bookings stack card-above-card (time-sorted; no side-by-side columns). Reads
                the SAME server-gated data as the grid (valuePennies zeroed w/o see-values; day totals
                already in `finance` since the day IS the period). Week view + md+ keep the grid. */}
            {view === 'day' && (
              <div className="md:hidden" onTouchStart={onListTouchStart} onTouchEnd={onListTouchEnd}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    {showMoney && finance.canSeeValues && (
                      <div className="text-sm"><span className="text-muted">{t('finance.booked')}: </span><span className="font-semibold text-ink tabular-nums">{money(finance.bookedPennies)}{exVatSuffix}</span></div>
                    )}
                    {showMoney && finance.canSeeMargin && (
                      <div className="text-sm"><span className="text-muted">{t('finance.margin')}: </span><span className={`font-semibold tabular-nums ${finance.marginPennies < 0 ? 'text-danger' : 'text-ink'}`}>{money(finance.marginPennies)}{exVatSuffix}</span></div>
                    )}
                  </div>
                  {anchor !== today && (
                    <Link href={`/admin/diary?site=${siteId}&view=day&date=${today}`} className="shrink-0 text-sm text-accent border border-line rounded-lg px-3 py-1.5 bg-surface">{t('todayBtn')}</Link>
                  )}
                </div>
                {listItems.length === 0 ? (
                  <div className="bg-surface-muted border border-line rounded-xl p-8 text-center text-muted">{t('mobileList.empty')}</div>
                ) : (
                  <div className="space-y-2">
                    {listItems.map((it) => it.kind === 'job' ? (
                      <button key={`j-${it.card.id}`} onClick={() => openCard(it.card.id)}
                        className="w-full text-left bg-surface border border-line rounded-xl p-3 flex gap-3 items-start active:bg-surface-muted"
                        style={{ borderLeft: `4px solid ${resolveColour(it.card.resourceColour)}` }}>
                        <div className="shrink-0 text-sm text-muted tabular-nums pt-0.5 w-14">{hhmm(it.card.startAt)}<br /><span className="text-xs">{hhmm(it.card.endAt)}</span></div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-ink">{it.card.reg}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-line text-muted whitespace-nowrap">{it.card.resourceName}</span>
                          </div>
                          <div className="text-sm text-ink">{it.card.customer}</div>
                          {it.card.services.map((s, i) => <div key={i} className="text-xs text-muted">{s}</div>)}
                        </div>
                        {showMoney && finance.canSeeValues && (
                          <div className={`shrink-0 text-sm font-semibold tabular-nums ${it.card.valuePennies < 0 ? 'text-danger' : 'text-ink'}`}>{money(it.card.valuePennies)}</div>
                        )}
                      </button>
                    ) : (
                      <div key={`n-${it.note.id}`} onDoubleClick={() => { if (canManage) setEditNote(it.note); }}
                        className="w-full bg-surface-muted border-2 border-dashed rounded-xl p-3 flex gap-3 items-center"
                        style={{ borderColor: it.note.colour || '#94a3b8' }}>
                        <div className="shrink-0 text-sm text-muted tabular-nums w-14">{hhmm(it.note.startAt)}</div>
                        <div className="min-w-0 flex-1 text-sm italic text-ink">{it.note.title}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* ONE scroll pane: 24h tall (vertical scroll) + week columns (horizontal). Column headers are
                sticky-top, the time axis sticky-left. On load it lands scrolled to the working day. */}
            <div ref={scrollRef} className={`overflow-auto border border-line rounded-lg ${view === 'day' ? 'hidden md:block' : ''}`} style={{ height: (REST_MIN + 28) * PX_PER_MIN, maxHeight: '78vh' }}>
              <div className="flex min-w-full">
                <div className="w-14 shrink-0 sticky left-0 z-20 bg-surface">
                  <div className={`${headH} sticky top-0 z-30 bg-surface border-b border-r border-line`} />
                  <div className="relative border-r border-line" style={{ height: DAY_MIN * PX_PER_MIN }}>
                    {HOURS.slice(0, 24).map((h) => (
                      <div key={h} style={{ top: h * 60 * PX_PER_MIN }} className="absolute right-0 pr-2 -mt-2 text-xs text-muted">{pad(h)}:00</div>
                    ))}
                  </div>
                </div>
                <div className="flex-1 flex min-w-0">
                  {columns.map((col) => {
                    // Jobs + lift/day notes for this column → unified overlap layout.
                    const items: Item[] = [];
                    for (const c of cards) {
                      if (view === 'day' && c.resourceId !== col.resourceId) continue;
                      for (const sg of segmentsForDay(c, col.date)) items.push({ s: sg.s, e: sg.e, top: sg.top, height: sg.height, kind: 'job', card: c });
                    }
                    for (const n of notes) {
                      if (view === 'day') { if (n.resourceId !== col.resourceId) continue; } // day-level handled by banner
                      for (const sg of segmentsForDay(n, col.date)) items.push({ s: sg.s, e: sg.e, top: sg.top, height: sg.height, kind: 'note', note: n });
                    }
                    const placed = layoutOverlap(items);
                    return (
                      <div key={col.key} className="flex-1 min-w-[46px] border-l border-line">
                        {(() => { const isToday = view === 'week' && col.date === today; return (
                        /* Today's column: black header cell, white text — the HEADER only, never the
                           column body (it must not fight the booking-block colours). */
                        <div className={`${headH} sticky top-0 z-10 border-b border-line px-1 flex flex-col items-center justify-center ${isToday ? 'bg-black text-white' : 'bg-surface'}`}>
                          <span className={`text-sm font-medium truncate w-full text-center leading-tight ${isToday ? 'text-white' : 'text-ink'}`}>{col.label}</span>
                          {showDayTotals && (() => { const d = finance.days[col.date] ?? { bookedPennies: 0, marginPennies: 0 }; return (
                            <span className="text-[9px] leading-tight text-center tabular-nums">
                              {finance.canSeeValues && <span className={`block ${isToday ? 'text-white/80' : 'text-muted'}`}>{t('finance.bookedShort')} {money(d.bookedPennies)}</span>}
                              {finance.canSeeMargin && <span className={`block ${d.marginPennies < 0 ? (isToday ? 'text-red-300' : 'text-danger') : (isToday ? 'text-white/80' : 'text-muted')}`}>{t('finance.marginShort')} {money(d.marginPennies)}</span>}
                            </span>
                          ); })()}
                        </div>
                        ); })()}
                        <div
                          className="relative bg-surface"
                          style={{ height: DAY_MIN * PX_PER_MIN, cursor: canManage ? 'context-menu' : undefined }}
                          onContextMenu={(e) => onColContext(col, e)}
                          onTouchStart={(e) => onColTouchStart(col, e)}
                          onTouchEnd={cancelPress}
                          onTouchMove={cancelPress}
                        >
                          {/* Out-of-hours (before open / after close) — a very light wash, lighter than the
                              lunch hatch, so working-vs-not reads at a glance. Display only; the engine still
                              binds bookings to working hours. */}
                          {openHour > 0 && <div className="absolute left-0 right-0 pointer-events-none" style={{ top: 0, height: openHour * 60 * PX_PER_MIN, backgroundColor: 'rgba(100,116,139,0.07)' }} />}
                          {closeHour < 24 && <div className="absolute left-0 right-0 pointer-events-none" style={{ top: closeHour * 60 * PX_PER_MIN, height: (DAY_MIN - closeHour * 60) * PX_PER_MIN, backgroundColor: 'rgba(100,116,139,0.07)' }} />}
                          {/* Non-working break bands (lunch etc.) — hatched grey, positioned by minute-of-midnight. */}
                          {breaks.map((b, bi) => {
                            const height = (b.end - b.start) * PX_PER_MIN;
                            if (height <= 0) return null;
                            return <div key={`br${bi}`} title={t('breakBand')} className="absolute left-0 right-0 pointer-events-none" style={{
                              top: b.start * PX_PER_MIN, height,
                              backgroundColor: 'rgba(100, 116, 139, 0.22)',
                              backgroundImage: 'repeating-linear-gradient(45deg, rgba(71,85,105,0.28) 0, rgba(71,85,105,0.28) 1px, transparent 1px, transparent 7px)',
                              borderTop: '1px solid rgba(100,116,139,0.4)', borderBottom: '1px solid rgba(100,116,139,0.4)',
                            }} />;
                          })}
                          {HOURS.slice(1, 24).map((h) => (
                            <div key={h} style={{ top: h * 60 * PX_PER_MIN }} className="absolute left-0 right-0 border-t border-line" />
                          ))}
                          {placed.map((x) => x.kind === 'job'
                            ? <JobBlock key={`${x.card.id}-${x.top}`} c={x.card} col={col} top={x.top} height={x.height} leftPct={(x.col / x.cols) * 100} widthPct={100 / x.cols} />
                            : <NoteBlock key={`${x.note.id}-${x.top}`} n={x.note} top={x.top} height={x.height} leftPct={(x.col / x.cols) * 100} widthPct={100 / x.cols} />)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {canManage && <p className="text-xs text-muted mt-2">{t('menu.hint')}</p>}
          </>
        )}
      </div>

      {/* Peek popover */}
      {peek && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPeek(null)} />
          <div className="fixed z-50 bg-surface border border-line rounded-xl shadow-lg p-3 w-64 text-sm"
            style={{ left: Math.min(peek.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 272), top: Math.min(peek.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200) }}>
            <div className="font-semibold text-ink text-base mb-1">{peek.card.reg}</div>
            <div className="space-y-0.5">
              <div><span className="text-muted">{t('peek.customer')}: </span><span className="text-ink">{peek.card.customer}</span></div>
              <div><span className="text-muted">{t('peek.lift')}: </span><span className="text-ink">{peek.card.resourceName}</span></div>
              <div><span className="text-muted">{t('peek.time')}: </span><span className="text-ink">{timeLabel(peek.card)}</span></div>
              <div><span className="text-muted">{t('peek.status')}: </span><span className="text-ink">{t(`status.${peek.card.status}`)}</span></div>
              {showMoney && finance.canSeeValues && <div><span className="text-muted">{t('peek.value')}: </span><span className="text-ink font-medium">{formatMoney(peek.card.valuePennies, { currency, locale })}</span></div>}
            </div>
            <Link href={cardHref(peek.card.id)} className="mt-2 inline-block text-accent hover:underline font-medium">{t('peek.open')} →</Link>
          </div>
        </>
      )}

      {/* Right-click / long-press context menu */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-50 bg-surface border border-line rounded-xl shadow-lg py-1 w-56 text-sm overflow-hidden"
            style={{ left: Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 232), top: Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200) }}>
            {menu.card ? (
              <>
                <div className="px-3 py-1.5 text-xs text-muted border-b border-line">{menu.card.reg} · {menu.card.resourceName}</div>
                <button className={menuBtn} onClick={() => { const m = menu!; setCreate({ date: m.date!, startAt: minToISO(m.date!, m.atMin!), resourceId: m.resourceId, mode: 'job' }); setMenu(null); }}>{t('menu.book')}</button>
                <div className="border-t border-line" />
                <button className={menuBtn} onClick={() => { const c = menu.card!; setMenu(null); openCard(c.id); }}>{t('menu.open')}</button>
                <button className={menuBtn} onClick={() => { setMove({ card: menu.card! }); setMenu(null); }}>{t('menu.reschedule')}</button>
                <button className={menuBtn} onClick={() => unbook(menu.card!)}>{t('menu.unbook')}</button>
                <button className={menuBtn} onClick={() => { const c = menu.card!; setCreate({ date: c.startAt.slice(0, 10), startAt: c.startAt, resourceId: c.resourceId, mode: 'note' }); setMenu(null); }}>{t('menu.addNote')}</button>
              </>
            ) : (
              <>
                <div className="px-3 py-1.5 text-xs text-muted border-b border-line">{hhmm(minToISO(menu.date!, menu.atMin!))}</div>
                <button className={menuBtn} onClick={() => { setCreate({ date: menu.date!, startAt: minToISO(menu.date!, menu.atMin!), resourceId: menu.resourceId, mode: 'job' }); setMenu(null); }}>{t('menu.book')}</button>
                <button className={menuBtn} onClick={() => { setCreate({ date: menu.date!, startAt: minToISO(menu.date!, menu.atMin!), resourceId: menu.resourceId, mode: 'note' }); setMenu(null); }}>{t('menu.addNote')}</button>
              </>
            )}
          </div>
        </>
      )}

      {create && (
        <CreateDialog
          info={create} siteId={siteId} resources={resources} defaultResourceId={create.resourceId ?? null}
          onClose={() => setCreate(null)} onDone={() => { setCreate(null); refresh(); }}
        />
      )}

      {move && (
        <MoveDialog
          card={move.card} resources={resources}
          onClose={() => setMove(null)} onDone={() => { setMove(null); refresh(); }}
        />
      )}

      {editNote && (
        <EditNoteDialog
          note={editNote} resources={resources}
          onClose={() => setEditNote(null)} onDone={() => { setEditNote(null); refresh(); }}
        />
      )}
    </>
  );
}

// ---- create dialogue (module scope so inputs don't remount on keystroke) ----
function CreateDialog({ info, siteId, resources, defaultResourceId, onClose, onDone }: {
  // pickWhen = opened WITHOUT cell context (the mobile toolbar "+ Add booking"): date pre-set to the
  // viewed day, but the user picks the start time AND the lift — no fabricated defaults. Same dialog,
  // same /api/jobcard path as the grid gesture; the grid path is untouched.
  info: { date: string; startAt: string; mode: 'job' | 'note'; resourceId?: string; pickWhen?: boolean };
  siteId: string; resources: ResourceCol[]; defaultResourceId: string | null;
  onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation('diary');
  const [mode, setMode] = useState<'choose' | 'job' | 'note'>(info.mode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hours, setHours] = useState('1');
  const pickWhen = !!info.pickWhen;
  const [whenDate, setWhenDate] = useState(info.date);
  const [whenTime, setWhenTime] = useState(''); // deliberately empty — the user must choose
  // job fields — Registration + Customer anchor the card; the rest are OPTIONAL (capture-if-available so
  // a card can be born with Customer Details complete). All wire through the existing create path.
  const [reg, setReg] = useState(''); const [cust, setCust] = useState(''); const [mileage, setMileage] = useState('');
  const [vin, setVin] = useState(''); const [phone, setPhone] = useState(''); const [email, setEmail] = useState('');
  // Vehicle data — make/colour/year/fuel/engine auto-fill from DVLA VES on a new reg; model is manual.
  const [make, setMake] = useState(''); const [model, setModel] = useState(''); const [vColour, setVColour] = useState('');
  const [year, setYear] = useState(''); const [fuel, setFuel] = useState(''); const [engineCc, setEngineCc] = useState('');
  const [liftId, setLiftId] = useState(pickWhen ? '' : (defaultResourceId ?? resources[0]?.id ?? '')); // blank flow: no default lift
  // note fields
  const [title, setTitle] = useState(''); const [noteLift, setNoteLift] = useState(defaultResourceId ?? ''); const [colour, setColour] = useState('');
  // Reg auto-fill: on reg-blur, look up a known car and pre-fill its vehicle + current-owner details so
  // returning cars aren't re-typed. lastLookedRef guards against repeat calls; autoFilledRef remembers
  // the reg we filled from, so switching to an unknown reg clears the STALE fill (but never a genuinely
  // hand-typed new car). Display convenience only — the create path stays authoritative for a known reg.
  const lastLookedRef = useRef<string>(''); const autoFilledRef = useRef<string | null>(null);
  // DVSA MOT reference (distinct from current mileage) — displayed + sent on create.
  const [mot, setMot] = useState<{ motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null }>({ motExpiry: null, lastMotMileage: null, lastMotDate: null });
  // Reg blur: canonicalise VISIBLY (uppercase, spaces stripped) so the user sees the stored form, then
  // look the car up on the canonical key.
  function onRegBlur() {
    const canon = normalizeReg(reg) || '';
    if (canon !== reg) setReg(canon);
    lookupReg(canon);
  }
  const [dvlaBusy, setDvlaBusy] = useState(false);
  async function lookupReg(regArg?: string) {
    const r = normalizeReg(regArg ?? reg) || '';
    if (!r || r === lastLookedRef.current) return;
    lastLookedRef.current = r;
    try {
      const res = await fetch(`/api/vehicle-lookup?reg=${encodeURIComponent(r)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.found) {
        // Returning car — fill from OUR record (owner + vehicle). No DVLA call.
        const v = data.vehicle || {};
        setCust(data.owner?.name || ''); setPhone(data.owner?.phone || ''); setEmail(data.owner?.email || '');
        setVin(v.vin || ''); setMileage(v.mileage != null ? String(v.mileage) : '');
        setMake(v.make || ''); setModel(v.model || ''); setVColour(v.colour || '');
        setFuel(v.fuel || ''); setYear(v.year != null ? String(v.year) : ''); setEngineCc(v.engineCc != null ? String(v.engineCc) : '');
        setMot({ motExpiry: null, lastMotMileage: null, lastMotDate: null }); // returning car — record already holds it
        autoFilledRef.current = r;
        return;
      }
      // New car: clear any stale auto-fill from a prior known reg, then enrich from DVSA / DVLA.
      if (autoFilledRef.current) {
        setCust(''); setPhone(''); setEmail(''); setVin(''); setMileage('');
        setMake(''); setModel(''); setVColour(''); setFuel(''); setYear(''); setEngineCc('');
        autoFilledRef.current = null;
      }
      setMot({ motExpiry: null, lastMotMileage: null, lastMotDate: null });
      setDvlaBusy(true);
      try {
        // Enrich from DVSA MOT History (make AND model + MOT metadata). cache:'no-store' so the browser
        // never serves a 304 — every reg must actually hit the route.
        let d: any = { found: false };
        const sres = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(r)}`, { cache: 'no-store' }).catch(() => null);
        if (sres?.ok) d = await sres.json();
        if (d.found) { // fill what DVSA gave
          if (d.make) setMake(d.make); if (d.model) setModel(d.model); if (d.colour) setVColour(d.colour);
          if (d.fuel) setFuel(d.fuel); if (d.year != null) setYear(String(d.year)); if (d.engineCc != null) setEngineCc(String(d.engineCc));
          setMot({ motExpiry: d.motExpiry ?? null, lastMotMileage: d.lastMotMileage ?? null, lastMotDate: d.lastMotDate ?? null });
        }
      } finally { setDvlaBusy(false); }
    } catch { /* best-effort — a failed pre-fill / DVLA error never blocks manual entry */ }
  }
  // Start: seeded from the clicked cell, or user-picked (pickWhen). End is naive start + hours (the
  // /api/jobcard bridge → workingMinutes = end-start = hours*60; the footprint re-expands correctly
  // around close/breaks). Duration is the source of truth.
  const startAt = pickWhen ? (whenTime ? `${whenDate}T${whenTime}:00.000Z` : '') : info.startAt;
  const endAt = startAt ? new Date(Date.parse(startAt) + Math.round(Number(hours || 0) * 60) * 60000).toISOString() : '';
  const when = pickWhen ? '' : `${info.date} · ${info.startAt.slice(11, 16)} · ${hours} hr`;

  // Blocking checks: required (reg, customer) + mileage (overflow breaks the DB write). Optional-field
  // format issues (VIN/phone/email) only WARN inline — messy real data is allowed through.
  const mileErr = mileageError(mileage);
  const regCanon = normalizeReg(reg) || '';
  const canSubmit = !!regCanon && !!cust.trim() && !!liftId && Number(hours) > 0 && !mileErr && !!startAt;
  async function createJob() {
    if (!regCanon) { setErr(t('create.err.regRequired')); return; }
    if (!cust.trim()) { setErr(t('create.err.customerRequired')); return; }
    if (!liftId || !(Number(hours) > 0) || !startAt) { setErr(t('create.err.booking')); return; }
    if (mileErr) { setErr(t(mileErr === 'overflow' ? 'create.warn.mileageOverflow' : 'create.warn.mileageNan')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/jobcard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registration: regCanon, customerName: cust.trim(), mileage: mileage.trim() || undefined,
        vin: normalizeVin(vin) || undefined, phone: normalizePhone(phone) || undefined, email: email.trim() || undefined,
        make: make.trim() || undefined, model: model.trim() || undefined, colour: vColour.trim() || undefined,
        fuel: fuel.trim() || undefined, year: year.trim() || undefined, engineCc: engineCc.trim() || undefined,
        motExpiry: mot.motExpiry ?? undefined, lastMotMileage: mot.lastMotMileage ?? undefined, lastMotDate: mot.lastMotDate ?? undefined,
        siteId, resourceId: liftId, startAt, endAt,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('create.err.generic')); return; }
    onDone();
  }
  async function addNote() {
    if (!title.trim()) { setErr(t('create.noteFailed')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/diary-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, title, startAt, endAt, resourceId: noteLift || null, colour: colour || null }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('create.noteFailed')); return; }
    onDone();
  }

  const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm focus:ring-accent focus:border-accent'; // ≥16px on mobile — under 16px iOS Safari zooms on focus
  const labelCls = 'block text-xs text-muted mb-1';
  const warnCls = 'text-[11px] text-warn mt-1'; // optional-field format warning (non-blocking)
  const durationField = (
    <div><label className={labelCls}>{t('create.duration')}</label>
      <select className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)}>
        {HOUR_OPTS.map((h) => <option key={h} value={String(h)}>{t('create.hoursOpt', { h })}</option>)}
      </select>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-line shadow-xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink">{t('create.title')}</h2>
        {when ? <p className="text-sm text-muted mb-4">{when}</p> : <div className="mb-4" />}
        {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}

        {mode === 'choose' && (
          <div className="flex flex-col sm:flex-row gap-3">
            <button onClick={() => setMode('job')} className="flex-1 bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-3 text-sm">{t('create.chooseJob')}</button>
            <button onClick={() => setMode('note')} className="flex-1 bg-surface-muted border border-line text-ink font-semibold rounded-lg px-4 py-3 text-sm">{t('create.chooseNote')}</button>
          </div>
        )}

        {mode === 'job' && (
          <div className="space-y-3">
            {/* Vehicle — Registration anchors the card; VIN + Mileage optional. */}
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('create.groupVehicle')}</div>
            <div>
              <label className={labelCls}>{t('create.reg')}</label>
              <input className={`${inputCls} max-w-[11rem] tracking-wider`} value={reg} maxLength={8} autoCapitalize="characters" autoCorrect="off" spellCheck={false} onChange={(e) => setReg(normalizeReg(e.target.value) || '')} onBlur={onRegBlur} />
              {dvlaBusy && <p className="text-[11px] text-muted mt-1">{t('create.dvlaLooking')}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>{t('create.make')}</label><input className={inputCls} value={make} onChange={(e) => setMake(e.target.value)} /></div>
              <div><label className={labelCls}>{t('create.model')}</label><input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className={labelCls}>{t('create.colour')}</label><input className={inputCls} value={vColour} onChange={(e) => setVColour(e.target.value)} /></div>
              <div><label className={labelCls}>{t('create.year')}</label><input className={inputCls} type="number" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} /></div>
              <div><label className={labelCls}>{t('create.fuel')}</label><input className={inputCls} value={fuel} onChange={(e) => setFuel(e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>{t('create.engineCc')}</label>
                <input className={inputCls} type="number" inputMode="numeric" value={engineCc} onChange={(e) => setEngineCc(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>{t('create.mileage')}</label>
                <input className={inputCls} type="number" inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value)} />
                {mileErr && <p className="text-[11px] text-danger mt-1">{t(mileErr === 'overflow' ? 'create.warn.mileageOverflow' : 'create.warn.mileageNan')}</p>}
              </div>
              <div>
                <label className={labelCls}>{t('create.vin')}</label>
                <input className={inputCls} value={vin} autoCapitalize="characters" autoCorrect="off" spellCheck={false} onChange={(e) => setVin(e.target.value)} />
                {vinWarn(vin) && <p className={warnCls}>{t('create.warn.vin')}</p>}
              </div>
            </div>
            {(mot.motExpiry || mot.lastMotMileage != null) && (
              <p className="text-[11px] text-muted">
                {mot.motExpiry && <>{t('create.motExpiry')}: <span className="text-ink">{mot.motExpiry}</span></>}
                {mot.lastMotMileage != null && <> · {t('create.lastMotMileage')}: <span className="text-ink">{mot.lastMotMileage}{mot.lastMotDate ? ` (${mot.lastMotDate})` : ''}</span></>}
              </p>
            )}
            {/* Owner — Customer required; Phone + Email optional. Lands on the current owner via the edge. */}
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted pt-1">{t('create.groupOwner')}</div>
            <div><label className={labelCls}>{t('create.customer')}</label><input className={inputCls} value={cust} onChange={(e) => setCust(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t('create.phone')}</label>
                <input className={inputCls} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                {phoneWarn(phone) && <p className={warnCls}>{t('create.warn.phone')}</p>}
              </div>
              <div>
                <label className={labelCls}>{t('create.email')}</label>
                <input className={inputCls} type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
                {emailWarn(email) && <p className={warnCls}>{t('create.warn.email')}</p>}
              </div>
            </div>
            {/* Booking */}
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted pt-1">{t('create.groupBooking')}</div>
            {pickWhen && (
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>{t('create.date')}</label><input className={inputCls} type="date" value={whenDate} onChange={(e) => setWhenDate(e.target.value)} /></div>
                <div><label className={labelCls}>{t('create.startTime')}</label><input className={inputCls} type="time" value={whenTime} onChange={(e) => setWhenTime(e.target.value)} /></div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>{t('create.lift')}</label>
                <select className={inputCls} value={liftId} onChange={(e) => setLiftId(e.target.value)}>
                  {pickWhen && <option value="">{t('create.pickLift')}</option>}
                  {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              {durationField}
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={createJob} disabled={busy || !canSubmit} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('create.working') : t('create.createJob')}</button>
              <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
            </div>
          </div>
        )}

        {mode === 'note' && (
          <div className="space-y-3">
            <div><label className={labelCls}>{t('create.noteTitle')}</label><input className={inputCls} placeholder={t('create.notePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div><label className={labelCls}>{t('create.lift')}</label>
              <select className={inputCls} value={noteLift} onChange={(e) => setNoteLift(e.target.value)}>
                <option value="">{t('create.dayLevel')}</option>
                {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            {durationField}
            <div>
              <label className={labelCls}>{t('create.colour')}</label>
              <div className="flex flex-wrap gap-2">
                {/* "None" — no colour */}
                <button
                  type="button" onClick={() => setColour('')}
                  aria-label={t('create.noColour')} title={t('create.noColour')} aria-pressed={colour === ''}
                  className={`w-8 h-8 rounded-full bg-surface flex items-center justify-center ${colour === '' ? 'ring-2 ring-accent ring-offset-1 border border-line' : 'border border-line'}`}
                >
                  <span className="text-muted text-xs leading-none">✕</span>
                </button>
                {RESOURCE_PALETTE.map((c) => (
                  <button
                    key={c} type="button" onClick={() => setColour(c)}
                    aria-label={c} title={c} aria-pressed={colour === c}
                    style={{ backgroundColor: c }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${colour === c ? 'ring-2 ring-accent ring-offset-1' : 'border border-line'}`}
                  >
                    {colour === c && <span className="text-white text-sm leading-none">✓</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={addNote} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('create.working') : t('create.addNote')}</button>
              <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- reschedule a booking (lift + start + duration) → PATCH /api/diary (same guard) ----
function MoveDialog({ card, resources, onClose, onDone }: {
  card: DiaryCard; resources: ResourceCol[]; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation('diary');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [liftId, setLiftId] = useState(card.resourceId);
  const [date, setDate] = useState(card.startAt.slice(0, 10));
  const [time, setTime] = useState(card.startAt.slice(11, 16));
  // Default duration = the booking's current working minutes (sum of footprint segments), snapped to 0.5 hr.
  const curMin = card.segments.reduce((a, s) => a + (Date.parse(s.endISO) - Date.parse(s.startISO)), 0) / 60000;
  const [hours, setHours] = useState(String(Math.max(0.5, Math.round(curMin / 30) * 0.5)));
  const startAt = `${date}T${time}:00.000Z`;

  async function save() {
    if (!liftId || !date || !time || !(Number(hours) > 0)) { setErr(t('move.failed')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/diary', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobCardId: card.id, resourceId: liftId, startAt, workingMinutes: Math.round(Number(hours) * 60) }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('move.failed')); return; }
    onDone();
  }

  const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm focus:ring-accent focus:border-accent'; // ≥16px on mobile — under 16px iOS Safari zooms on focus
  const labelCls = 'block text-xs text-muted mb-1';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-line shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink">{t('move.title')}</h2>
        <p className="text-sm text-muted mb-4">{card.reg} · {card.customer}</p>
        {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}
        <div className="space-y-3">
          <div><label className={labelCls}>{t('create.lift')}</label>
            <select className={inputCls} value={liftId} onChange={(e) => setLiftId(e.target.value)}>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>{t('move.date')}</label><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div><label className={labelCls}>{t('move.time')}</label><input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} /></div>
          </div>
          <div><label className={labelCls}>{t('create.duration')}</label>
            <select className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)}>
              {(HOUR_OPTS.includes(Number(hours)) ? HOUR_OPTS : [Number(hours), ...HOUR_OPTS]).map((h) => <option key={h} value={String(h)}>{t('create.hoursOpt', { h })}</option>)}
            </select>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('create.working') : t('move.save')}</button>
            <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- edit / delete a note (module scope so inputs don't remount) ----
function EditNoteDialog({ note, resources, onClose, onDone }: {
  note: DiaryNoteView; resources: ResourceCol[]; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation('diary');
  const dPart = (iso: string) => iso.slice(0, 10);
  const tPart = (iso: string) => iso.slice(11, 16);
  const [title, setTitle] = useState(note.title);
  const [startDate, setStartDate] = useState(dPart(note.startAt));
  const [startTime, setStartTime] = useState(tPart(note.startAt));
  const [endDate, setEndDate] = useState(dPart(note.endAt));
  const [endTime, setEndTime] = useState(tPart(note.endAt));
  const [noteLift, setNoteLift] = useState(note.resourceId ?? '');
  const [colour, setColour] = useState(note.colour ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fieldBase = 'p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm focus:ring-accent focus:border-accent'; // ≥16px on mobile (iOS zoom threshold)
  const inputCls = `w-full ${fieldBase}`;
  const labelCls = 'block text-xs text-muted mb-1';

  async function save() {
    if (!title.trim()) { setErr(t('editNote.saveError')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/diary-notes', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note.id, title, startAt: `${startDate}T${startTime}:00.000Z`, endAt: `${endDate}T${endTime}:00.000Z`, resourceId: noteLift || null, colour: colour || null }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('editNote.saveError')); return; }
    onDone();
  }
  async function del() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/diary-notes?id=${note.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('editNote.deleteError')); return; }
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-line shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink mb-4">{t('editNote.title')}</h2>
        {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}
        <div className="space-y-3">
          <div><label className={labelCls}>{t('create.noteTitle')}</label><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          {/* Start/end stacked; date flexes, time is a fixed narrow field — fits inside the box at all widths. */}
          <div><label className={labelCls}>{t('create.start')}</label>
            <div className="flex gap-2">
              <input type="date" className={`${fieldBase} flex-1 min-w-0`} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <input type="time" className={`${fieldBase} w-24 shrink-0`} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
          </div>
          <div><label className={labelCls}>{t('create.end')}</label>
            <div className="flex gap-2">
              <input type="date" className={`${fieldBase} flex-1 min-w-0`} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              <input type="time" className={`${fieldBase} w-24 shrink-0`} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>
          <div><label className={labelCls}>{t('create.lift')}</label>
            <select className={inputCls} value={noteLift} onChange={(e) => setNoteLift(e.target.value)}>
              <option value="">{t('create.dayLevel')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('create.colour')}</label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setColour('')} aria-label={t('create.noColour')} title={t('create.noColour')} aria-pressed={colour === ''}
                className={`w-8 h-8 rounded-full bg-surface flex items-center justify-center ${colour === '' ? 'ring-2 ring-accent ring-offset-1 border border-line' : 'border border-line'}`}>
                <span className="text-muted text-xs leading-none">✕</span>
              </button>
              {RESOURCE_PALETTE.map((c) => (
                <button key={c} type="button" onClick={() => setColour(c)} aria-label={c} title={c} aria-pressed={colour === c} style={{ backgroundColor: c }}
                  className={`w-8 h-8 rounded-full flex items-center justify-center ${colour === c ? 'ring-2 ring-accent ring-offset-1' : 'border border-line'}`}>
                  {colour === c && <span className="text-white text-sm leading-none">✓</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <button onClick={save} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('editNote.saving') : t('editNote.save')}</button>
              <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
            </div>
            {confirmDel ? (
              <button onClick={del} disabled={busy} className="bg-danger text-white font-semibold rounded-lg px-3 py-2.5 text-sm disabled:opacity-50">{t('editNote.confirmYes')}</button>
            ) : (
              <button onClick={() => setConfirmDel(true)} className="text-danger hover:underline text-sm">{t('editNote.delete')}</button>
            )}
          </div>
          {confirmDel && <p className="text-xs text-danger text-right">{t('editNote.confirmDelete')}</p>}
        </div>
      </div>
    </div>
  );
}

export const getServerSideProps = withI18n(['diary'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };

  const vis = await getVisibility(user.id as string);
  if (vis.siteIds.length === 0) {
    const today = ymd(new Date());
    return { props: { siteId: '', siteName: '', view: 'week', anchor: today, prev: today, next: today, days: [], resources: [], cards: [], notes: [], openHour: 8, closeHour: 18, breaks: [], currency: 'GBP', locale: 'en-GB', canManage: false, weekStart: 1, today, finance: { canSeeValues: false, canSeeMargin: false, vatRegistered: false, bookedPennies: 0, marginPennies: 0, days: {} }, noSites: true } };
  }

  // Default to the user's PRIMARY location; a valid ?site switches. Forced out-of-scope ?site
  // (not one of vis.siteIds) falls back to primary — never shows another location's diary.
  const wanted = (ctx.query.site as string) || vis.primarySiteId || '';
  const resolvedId = wanted && vis.siteIds.includes(wanted) ? wanted : (vis.primarySiteId ?? vis.siteIds[0]);
  const site = (await prisma.site.findFirst({
    where: { id: resolvedId },
    select: { id: true, site_name: true, open_days: true, open_hour: true, close_hour: true, breaks: true, week_start: true, currency_code: true, locale: true },
  })) as any;
  if (!site) return { redirect: { destination: '/admin/diary', permanent: false } };

  const openDays: number[] = (site.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6]).slice().sort((a: number, b: number) => a - b);
  const openHour: number = site.open_hour ?? 8;
  const closeHour: number = site.close_hour ?? 18;
  const breaks: Break[] = parseBreaks(site.breaks);
  const weekStart: number = site.week_start ?? 1;
  const perms = await getTenantPermissions(user.group_id as string);
  const canManage = canCreateDiaryEntry(vis, site.id, perms); // create gesture + note edit (manager OR STANDARD+toggle)
  const vat = await getTenantVat(user.group_id as string); // master switch — peek value must respect it

  const viewParam = String(ctx.query.view || '');
  const view: DiaryView = viewParam === 'day' || viewParam === 'month' || viewParam === 'year' ? viewParam : 'week';
  const dateParam = (ctx.query.date as string) || '';
  const anchorObj = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00.000Z`) : new Date(`${ymd(new Date())}T00:00:00.000Z`);
  const anchor = ymd(anchorObj);
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let rangeStart: Date, rangeEnd: Date, days: DayCol[], prev: string, next: string;
  if (view === 'month' || view === 'year') {
    // Revenue-view PLACEHOLDERS: no booking data is fetched or shown at these zooms (they will show
    // the paid-ledger aggregate once the invoice artifact exists — never quoted-pipeline figures).
    rangeStart = anchorObj; rangeEnd = anchorObj; days = [];
    const m = anchorObj.getUTCMonth(), y = anchorObj.getUTCFullYear();
    prev = view === 'month' ? ymd(new Date(Date.UTC(y, m - 1, 1))) : ymd(new Date(Date.UTC(y - 1, m, 1)));
    next = view === 'month' ? ymd(new Date(Date.UTC(y, m + 1, 1))) : ymd(new Date(Date.UTC(y + 1, m, 1)));
  } else if (view === 'week') {
    const dow = anchorObj.getUTCDay();
    const offset = (dow - weekStart + 7) % 7;
    const weekStartObj = new Date(anchorObj.getTime() - offset * 86400000);
    rangeStart = weekStartObj;
    rangeEnd = new Date(weekStartObj.getTime() + 7 * 86400000);
    days = Array.from({ length: 7 }, (_, i) => new Date(weekStartObj.getTime() + i * 86400000))
      .filter((d) => openDays.includes(d.getUTCDay()))
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
  const [resourceRows, cardRows, noteRows] = await Promise.all([
    prisma.resource.findMany({ where: { site_id: site.id, is_active: true }, orderBy: { display_order: 'asc' }, select: { id: true, name: true, type: true, colour: true } }) as Promise<ResRow[]>,
    (view === 'month' || view === 'year') ? Promise.resolve([]) : prisma.jobCard.findMany({
      where: { site_id: site.id, resource_id: { not: null }, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: {
        id: true, resource_id: true, start_at: true, end_at: true, booking_duration_minutes: true, status: true, vat_rate: true, is_comeback: true,
        resource: { select: { name: true, colour: true } }, vehicle: { select: { registration: true } }, customer: { select: { name: true } },
        items: { select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true }, orderBy: { created_at: 'asc' } },
      },
    }) as Promise<any[]>,
    (view === 'month' || view === 'year') ? Promise.resolve([]) : prisma.diaryNote.findMany({
      where: { site_id: site.id, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: { id: true, title: true, resource_id: true, colour: true, start_at: true, end_at: true },
    }) as Promise<any[]>,
  ]);

  const resources: ResourceCol[] = resourceRows.map((r) => ({ id: r.id, name: r.name, type: r.type, colour: r.colour }));
  const num = (d: any) => (d == null ? 0 : Number(d));
  // Financial visibility for THIS user — decides what money is even sent to the client (server-gated).
  const fin = financeVisibility(vis, perms);
  const rangeStartMs = rangeStart.getTime(), rangeEndMs = rangeEnd.getTime();
  let bookedPennies = 0, marginPennies = 0;
  const dayAgg: Record<string, { booked: number; margin: number }> = {}; // per-day totals (week view)
  const cards: DiaryCard[] = cardRows.map((c) => {
    const totals = computeQuoteTotals(
      (c.items as any[]).map((it) => ({ item_type: it.item_type, qty: num(it.qty), unit_price_pennies: poundsToPennies(num(it.unit_price)), unit_cost_pennies: poundsToPennies(num(it.unit_cost)), vatable: num(it.vat_rate) > 0 })),
      num(c.vat_rate),
      { vatRegistered: vat.registered },
    );
    const startAt = (c.start_at as Date).toISOString();
    // Occupancy footprint from the WORKING duration (source of truth; fallback (end - start) pre-backfill).
    const mins = c.booking_duration_minutes ?? Math.round(((c.end_at as Date).getTime() - (c.start_at as Date).getTime()) / 60000);
    const fp = computeFootprint(startAt, mins, openHour, closeHour, openDays, breaks);
    // Day-view block label: the clean service TITLE (first line of a fixed line = the Title per the
    // title model). Prefer fixed services; else fall back to the labour/parts line names. "First +N".
    const firstLine = (s: string) => (s || '').split('\n')[0].trim();
    const items = c.items as any[];
    const fixedNames = items.filter((it) => it.item_type === 'fixed').map((it) => firstLine(it.description)).filter(Boolean);
    const labels = fixedNames.length ? fixedNames : items.map((it) => firstLine(it.description)).filter(Boolean);
    const serviceSummary = labels.length ? (labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0]) : ''; // week: compact
    const services = labels; // day: full list, one per line
    // ALL figures EX-VAT — this is a P&L view, and VAT nets out of margin (output VAT on sales →
    // HMRC, input VAT on purchases reclaimed). Booked = ex-VAT revenue (labour + parts sold); Margin =
    // ex-VAT revenue − ex-VAT parts cost (labour EXCLUDED — fixed overhead). A comeback = £0 revenue,
    // still its parts-cost drag. Period-matched by BOOKING day (no cross-period double-count).
    const revenueEx = c.is_comeback ? 0 : (totals.labour_pennies + totals.parts_pennies);
    const startMs = (c.start_at as Date).getTime();
    if (startMs >= rangeStartMs && startMs < rangeEndMs) {
      bookedPennies += revenueEx;
      marginPennies += revenueEx - totals.parts_cost_pennies;
      const dk = ymd(new Date(startMs));
      const d = (dayAgg[dk] ??= { booked: 0, margin: 0 });
      d.booked += revenueEx; d.margin += revenueEx - totals.parts_cost_pennies;
    }
    return {
      id: c.id, resourceId: c.resource_id as string, resourceName: c.resource?.name ?? '—', resourceColour: c.resource?.colour ?? null,
      reg: c.vehicle?.registration ?? '—', customer: c.customer?.name ?? '—', serviceSummary, services,
      startAt, endAt: fp.endISO, // endAt = TRUE wrapped end (tooltip shows the real end, not raw 20:00)
      status: c.status as string,
      // Block value (EX-VAT): normal job = ex-VAT revenue; comeback = the DRAIN = −(ex-VAT parts cost),
      // matching what the margin total subtracts. Totals compute from `totals` directly, unaffected.
      valuePennies: fin.seeValues ? (c.is_comeback ? -totals.parts_cost_pennies : revenueEx) : 0,
      segments: fp.segments,
    };
  });
  // Per-day totals for week view (gated the same as the period totals).
  const days_finance: Record<string, { bookedPennies: number; marginPennies: number }> = {};
  for (const [dk, agg] of Object.entries(dayAgg)) {
    days_finance[dk] = { bookedPennies: fin.seeValues ? agg.booked : 0, marginPennies: fin.seeMargin ? agg.margin : 0 };
  }
  const finance = {
    canSeeValues: fin.seeValues, canSeeMargin: fin.seeMargin, vatRegistered: vat.registered,
    bookedPennies: fin.seeValues ? bookedPennies : 0,
    marginPennies: fin.seeMargin ? marginPennies : 0,
    days: days_finance,
  };
  const notes: DiaryNoteView[] = noteRows.map((n) => ({ id: n.id, title: n.title, resourceId: n.resource_id ?? null, colour: n.colour ?? null, startAt: (n.start_at as Date).toISOString(), endAt: (n.end_at as Date).toISOString() }));

  return { props: { siteId: site.id, siteName: site.site_name, view, anchor, prev, next, days, resources, cards, notes, openHour, closeHour, breaks, currency: site.currency_code ?? 'GBP', locale: site.locale ?? 'en-GB', canManage, weekStart, today: ymd(new Date()), finance } };
});
