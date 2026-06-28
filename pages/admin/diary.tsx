/**
 * File: pages/admin/diary.tsx
 * Continuous-time diary. Source of truth = JobCard.start_at / end_at.
 *   ?view=week (default) → 7 day columns, location-wide, blocks by time with overlap lanes.
 *   ?view=day            → resource columns for one day, blocks by time.
 * Place a card = pick card + resource + date + start time + duration. Guard = interval overlap
 * on the same resource (server, /api/diary). Phase 1: times are wall-clock stored in UTC,
 * window hardcoded 07:00–18:00.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';

const WIN_START_HOUR = 7;
const WIN_END_HOUR = 18;
const WIN_MIN = (WIN_END_HOUR - WIN_START_HOUR) * 60; // 660 → 1px per minute
const PX_PER_MIN = 1;

type ResourceCol = { id: string; name: string; type: string };
type DiaryCard = { id: string; resourceId: string; resourceName: string; reg: string; customer: string; status: string; startAt: string; endAt: string };
type UnscheduledCard = { id: string; reg: string; customer: string };
type DayCol = { date: string; label: string };
type PageProps = {
  siteId: string; siteName: string; view: 'week' | 'day'; anchor: string;
  prev: string; next: string; days: DayCol[];
  resources: ResourceCol[]; cards: DiaryCard[]; unscheduled: UnscheduledCard[];
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function dayStartMs(date: string) { return Date.parse(`${date}T00:00:00.000Z`); }

// Compute a card's visible segment (px) within a given day's window; null if not visible.
function segment(card: { startAt: string; endAt: string }, date: string) {
  const winStart = dayStartMs(date) + WIN_START_HOUR * 3600000;
  const winEnd = dayStartMs(date) + WIN_END_HOUR * 3600000;
  const s = Math.max(Date.parse(card.startAt), winStart);
  const e = Math.min(Date.parse(card.endAt), winEnd);
  if (e <= s) return null;
  return { top: (s - winStart) / 60000 * PX_PER_MIN, height: Math.max(14, (e - s) / 60000 * PX_PER_MIN), s, e };
}

// Greedy overlap-lane assignment for a day's segments (Outlook-style side-by-side).
function assignLanes<T extends { s: number; e: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.s - b.s);
  const laneEnds: number[] = [];
  const out: Array<T & { lane: number; lanes: number }> = [];
  for (const it of sorted) {
    let lane = laneEnds.findIndex((end) => end <= it.s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.e); } else { laneEnds[lane] = it.e; }
    out.push({ ...it, lane, lanes: 0 });
  }
  const total = laneEnds.length || 1;
  return out.map((o) => ({ ...o, lanes: total }));
}

const HOURS = Array.from({ length: WIN_END_HOUR - WIN_START_HOUR + 1 }, (_, i) => WIN_START_HOUR + i);

function statusColour(status: string) {
  if (status === 'completed') return 'bg-green-800 border-green-600';
  return 'bg-blue-800 border-blue-500';
}

export default function DiaryPage(props: PageProps) {
  const { siteId, siteName, view, anchor, prev, next, days, resources, cards, unscheduled } = props;
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  const [msg, setMsg] = useState<{ text: string; type: 'error' | 'success' } | null>(null);

  // Placement form state
  const [jobCardId, setJobCardId] = useState('');
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const [date, setDate] = useState(view === 'day' ? anchor : days[0]?.date ?? anchor);
  const [time, setTime] = useState('09:00');
  const [hours, setHours] = useState('2');

  async function place(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!jobCardId || !resourceId) { setMsg({ text: 'Pick a job card and a resource.', type: 'error' }); return; }
    const startAt = new Date(`${date}T${time}:00.000Z`);
    const dur = Number(hours);
    if (!Number.isFinite(dur) || dur <= 0) { setMsg({ text: 'Duration must be a positive number of hours.', type: 'error' }); return; }
    const endAt = new Date(startAt.getTime() + dur * 3600000);
    const res = await fetch('/api/diary', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobCardId, resourceId, startAt: startAt.toISOString(), endAt: endAt.toISOString() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg({ text: data?.message || 'Failed to place.', type: 'error' }); return; }
    setMsg({ text: 'Job card placed.', type: 'success' });
    setJobCardId('');
    refresh();
  }

  async function unplace(id: string) {
    setMsg(null);
    const res = await fetch(`/api/diary?jobCardId=${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setMsg({ text: d?.message || 'Failed to unplace.', type: 'error' }); return; }
    refresh();
  }

  // Build the columns to render: week → days; day → resources (each for the single day).
  const columns =
    view === 'week'
      ? days.map((d) => ({ key: d.date, label: d.label, date: d.date, cards }))
      : resources.map((r) => ({ key: r.id, label: `${r.name} (${r.type})`, date: anchor, cards: cards.filter((c) => c.resourceId === r.id) }));

  const fmt = (iso: string) => new Date(iso).toISOString().slice(11, 16);

  return (
    <AdminLayout>
      <Head><title>Diary - GreaseDesk</title></Head>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold text-white">Diary — {siteName}</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-slate-600">
            <Link href={`/admin/diary?site=${siteId}&view=week&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'week' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>Week</Link>
            <Link href={`/admin/diary?site=${siteId}&view=day&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'day' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>Day</Link>
          </div>
          <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${prev}`} className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm text-slate-200 hover:bg-slate-600">←</Link>
          <span className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">{view === 'week' ? `Week of ${days[0]?.date}` : anchor}</span>
          <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${next}`} className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm text-slate-200 hover:bg-slate-600">→</Link>
        </div>
      </div>

      {msg && <div className={`p-3 rounded-lg mb-4 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}

      {/* Placement form */}
      <form onSubmit={place} className="bg-slate-800 border border-slate-700 rounded-xl p-3 mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Job card</label>
          <select value={jobCardId} onChange={(e) => setJobCardId(e.target.value)} className="p-2 bg-slate-700 border border-slate-600 rounded text-white text-sm min-w-[180px]">
            <option value="">Unscheduled… ({unscheduled.length})</option>
            {unscheduled.map((u) => <option key={u.id} value={u.id}>{u.reg} — {u.customer}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Resource</label>
          <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} className="p-2 bg-slate-700 border border-slate-600 rounded text-white text-sm">
            {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div><label className="block text-xs text-slate-400 mb-1">Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="p-2 bg-slate-700 border border-slate-600 rounded text-white text-sm" /></div>
        <div><label className="block text-xs text-slate-400 mb-1">Start</label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="p-2 bg-slate-700 border border-slate-600 rounded text-white text-sm" /></div>
        <div><label className="block text-xs text-slate-400 mb-1">Hours</label><input type="number" step="0.5" min="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className="p-2 bg-slate-700 border border-slate-600 rounded text-white text-sm w-20" /></div>
        <button type="submit" className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm">Place</button>
      </form>

      {resources.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center text-slate-400">
          This location has no resources. Add some in Settings → Locations &amp; Resources.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex min-w-max">
            {/* Time axis */}
            <div className="w-16 shrink-0 pt-7">
              {HOURS.map((h) => (
                <div key={h} style={{ height: 60 * PX_PER_MIN }} className="text-xs text-slate-500 text-right pr-2 -mt-2">{String(h).padStart(2, '0')}:00</div>
              ))}
            </div>
            {/* Columns */}
            {columns.map((col) => {
              const segs = col.cards
                .map((c) => { const sg = segment(c, col.date); return sg ? { ...sg, card: c } : null; })
                .filter(Boolean) as Array<{ top: number; height: number; s: number; e: number; card: DiaryCard }>;
              const laid = view === 'week' ? assignLanes(segs) : segs.map((x) => ({ ...x, lane: 0, lanes: 1 }));
              return (
                <div key={col.key} className="w-48 shrink-0 border-l border-slate-800">
                  <div className="h-7 text-sm text-white text-center font-medium truncate px-1">{col.label}</div>
                  <div className="relative bg-slate-900/40" style={{ height: WIN_MIN * PX_PER_MIN }}>
                    {HOURS.slice(1).map((h, i) => (
                      <div key={h} style={{ top: (i + 1) * 60 * PX_PER_MIN }} className="absolute left-0 right-0 border-t border-slate-800/70" />
                    ))}
                    {laid.map((x) => {
                      const widthPct = 100 / x.lanes;
                      return (
                        <div
                          key={x.card.id}
                          style={{ top: x.top, height: x.height, left: `${x.lane * widthPct}%`, width: `calc(${widthPct}% - 2px)` }}
                          className={`absolute rounded-md border px-1.5 py-1 text-[11px] text-white overflow-hidden ${statusColour(x.card.status)}`}
                          title={`${x.card.reg} — ${x.card.customer} (${fmt(x.card.startAt)}–${fmt(x.card.endAt)})`}
                        >
                          <div className="font-semibold truncate">{x.card.reg}</div>
                          <div className="truncate text-slate-200">{x.card.customer}</div>
                          {view === 'week' && <div className="truncate text-slate-300">{x.card.resourceName}</div>}
                          <div className="flex items-center justify-between mt-0.5">
                            <Link href={`/admin/jobcards/${x.card.id}`} className="underline text-slate-200">view</Link>
                            <button onClick={() => unplace(x.card.id)} className="text-red-300 hover:text-red-200">unplace</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  const groupId = user.group_id as string;

  const requestedSite = (ctx.query.site as string) || user.site_id;
  const site = await prisma.site.findFirst({ where: { id: requestedSite, group_id: groupId }, select: { id: true, site_name: true } });
  if (!site) return { redirect: { destination: '/admin/diary', permanent: false } };

  const view: 'week' | 'day' = ctx.query.view === 'day' ? 'day' : 'week';
  const dateParam = (ctx.query.date as string) || '';
  const anchorObj = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00.000Z`) : new Date(`${ymd(new Date())}T00:00:00.000Z`);
  const anchor = ymd(anchorObj);

  let rangeStart: Date, rangeEnd: Date, days: DayCol[], prev: string, next: string;
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (view === 'week') {
    // Week starts Monday (UTC).
    const dow = anchorObj.getUTCDay(); // 0=Sun
    const mondayOffset = (dow + 6) % 7;
    const weekStart = new Date(anchorObj.getTime() - mondayOffset * 86400000);
    rangeStart = weekStart;
    rangeEnd = new Date(weekStart.getTime() + 7 * 86400000);
    days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart.getTime() + i * 86400000);
      return { date: ymd(d), label: `${DAY_LABELS[d.getUTCDay()]} ${d.getUTCDate()}` };
    });
    prev = ymd(new Date(anchorObj.getTime() - 7 * 86400000));
    next = ymd(new Date(anchorObj.getTime() + 7 * 86400000));
  } else {
    rangeStart = anchorObj;
    rangeEnd = new Date(anchorObj.getTime() + 86400000);
    days = [{ date: anchor, label: anchor }];
    prev = ymd(new Date(anchorObj.getTime() - 86400000));
    next = ymd(new Date(anchorObj.getTime() + 86400000));
  }

  type ResRow = { id: string; name: string; type: string };
  type CardRow = { id: string; resource_id: string | null; start_at: Date | null; end_at: Date | null; status: string; resource: { name: string } | null; vehicle: { registration: string | null } | null; customer: { name: string } | null };
  type UnRow = { id: string; vehicle: { registration: string | null } | null; customer: { name: string } | null };

  const [resourceRows, cardRows, unschedRows] = await Promise.all([
    prisma.resource.findMany({ where: { site_id: site.id, is_active: true }, orderBy: { display_order: 'asc' }, select: { id: true, name: true, type: true } }) as Promise<ResRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, resource_id: { not: null }, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: { id: true, resource_id: true, start_at: true, end_at: true, status: true, resource: { select: { name: true } }, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<CardRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, OR: [{ start_at: null }, { resource_id: null }], archived_at: null },
      orderBy: { created_at: 'desc' },
      select: { id: true, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<UnRow[]>,
  ]);

  const resources: ResourceCol[] = resourceRows.map((r: ResRow) => ({ id: r.id, name: r.name, type: r.type }));
  const cards: DiaryCard[] = cardRows.map((c: CardRow) => ({
    id: c.id,
    resourceId: c.resource_id as string,
    resourceName: c.resource?.name ?? '—',
    reg: c.vehicle?.registration ?? '—',
    customer: c.customer?.name ?? '—',
    status: c.status,
    startAt: (c.start_at as Date).toISOString(),
    endAt: (c.end_at as Date).toISOString(),
  }));
  const unscheduled: UnscheduledCard[] = unschedRows.map((u: UnRow) => ({ id: u.id, reg: u.vehicle?.registration ?? '—', customer: u.customer?.name ?? '—' }));

  return { props: { siteId: site.id, siteName: site.site_name, view, anchor, prev, next, days, resources, cards, unscheduled } };
};
