/**
 * File: pages/admin/diary.tsx
 * Continuous-time diary, light (Apple/Outlook) theme — this view only.
 * Source of truth = JobCard.start_at / end_at. Resource colour drives a left-edge bar +
 * pale tint on each block.
 *   ?view=week (default): 07:00–18:00 axis, 7 day columns. ≤4 lifts → one coloured lane per
 *     lift (reg-only blocks). >4 lifts → that day collapses to coloured dots (colour = lift).
 *   ?view=day: per-resource columns (always columns), coloured reg-only blocks.
 * Hover tooltip = reg · customer · lift · time. Click reg → job card; ✕ → unplace.
 * Phase 1: times are wall-clock stored in UTC; window hardcoded 07:00–18:00.
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
import { resolveColour, blockTint } from '@/lib/diary-colours';
import { getVisibility } from '@/lib/site-visibility';

const WIN_START_HOUR = 7;
const WIN_END_HOUR = 18;
const WIN_MIN = (WIN_END_HOUR - WIN_START_HOUR) * 60;
const PX_PER_MIN = 1;
const LANE_THRESHOLD = 4; // ≤4 lifts → lanes; >4 → dots (week view)

type ResourceCol = { id: string; name: string; type: string; colour: string | null };
type DiaryCard = { id: string; resourceId: string; resourceName: string; resourceColour: string | null; reg: string; customer: string; startAt: string; endAt: string };
type UnscheduledCard = { id: string; reg: string; customer: string };
type DayCol = { date: string; label: string };
type PageProps = {
  siteId: string; siteName: string; view: 'week' | 'day'; anchor: string;
  prev: string; next: string; days: DayCol[];
  resources: ResourceCol[]; cards: DiaryCard[]; unscheduled: UnscheduledCard[];
  noSites?: boolean;
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function dayStartMs(date: string) { return Date.parse(`${date}T00:00:00.000Z`); }
function fmt(iso: string) { return new Date(iso).toISOString().slice(11, 16); }

function segment(card: { startAt: string; endAt: string }, date: string) {
  const winStart = dayStartMs(date) + WIN_START_HOUR * 3600000;
  const winEnd = dayStartMs(date) + WIN_END_HOUR * 3600000;
  const s = Math.max(Date.parse(card.startAt), winStart);
  const e = Math.min(Date.parse(card.endAt), winEnd);
  if (e <= s) return null;
  return { top: (s - winStart) / 60000 * PX_PER_MIN, height: Math.max(16, (e - s) / 60000 * PX_PER_MIN), s, e };
}

// Greedy overlap-lane x-offset (used to spread dots in >4-lift week days).
function assignLanes<T extends { s: number; e: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.s - b.s);
  const laneEnds: number[] = [];
  const out: Array<T & { lane: number }> = [];
  for (const it of sorted) {
    let lane = laneEnds.findIndex((end) => end <= it.s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.e); } else { laneEnds[lane] = it.e; }
    out.push({ ...it, lane });
  }
  return out;
}

const HOURS = Array.from({ length: WIN_END_HOUR - WIN_START_HOUR + 1 }, (_, i) => WIN_START_HOUR + i);
const tooltip = (c: DiaryCard) => `${c.reg} · ${c.customer} · ${c.resourceName} · ${fmt(c.startAt)}–${fmt(c.endAt)}`;

export default function DiaryPage(props: PageProps) {
  const { siteId, siteName, view, anchor, prev, next, days, resources, cards, unscheduled, noSites } = props;
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  const [msg, setMsg] = useState<{ text: string; type: 'error' | 'success' } | null>(null);
  const [jobCardId, setJobCardId] = useState('');
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const [date, setDate] = useState(view === 'day' ? anchor : days[0]?.date ?? anchor);
  const [time, setTime] = useState('09:00');
  const [hours, setHours] = useState('2');

  const laneMode = resources.length <= LANE_THRESHOLD; // week view
  const laneIndex = new Map(resources.map((r, i) => [r.id, i]));

  if (noSites) {
    return (
      <AdminLayout>
        <Head><title>Diary - GreaseDesk</title></Head>
        <div className="bg-white text-slate-800 rounded-xl border border-slate-200 p-8 text-center shadow">
          You’re not currently assigned to a location — contact your admin.
        </div>
      </AdminLayout>
    );
  }

  async function place(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!jobCardId || !resourceId) { setMsg({ text: 'Pick a job card and a resource.', type: 'error' }); return; }
    const startAt = new Date(`${date}T${time}:00.000Z`);
    const dur = Number(hours);
    if (!Number.isFinite(dur) || dur <= 0) { setMsg({ text: 'Duration must be a positive number of hours.', type: 'error' }); return; }
    const endAt = new Date(startAt.getTime() + dur * 3600000);
    const res = await fetch('/api/diary', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, resourceId, startAt: startAt.toISOString(), endAt: endAt.toISOString() }) });
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

  // A single coloured block (reg-only + tooltip).
  function Block({ c, style }: { c: DiaryCard; style: React.CSSProperties }) {
    const colour = resolveColour(c.resourceColour);
    return (
      <div
        style={{ ...style, backgroundColor: blockTint(colour), borderLeft: `4px solid ${colour}` }}
        className="absolute rounded-md px-1.5 py-0.5 text-[11px] text-slate-800 overflow-hidden shadow-sm"
        title={tooltip(c)}
      >
        <div className="flex items-center justify-between gap-1">
          <Link href={`/admin/jobcards/${c.id}`} className="font-semibold truncate hover:underline">{c.reg}</Link>
          <button onClick={() => unplace(c.id)} className="text-slate-500 hover:text-red-600 leading-none shrink-0" title="Unplace">✕</button>
        </div>
      </div>
    );
  }

  // Build columns: week → 7 days; day → resources (single day).
  const columns =
    view === 'week'
      ? days.map((d) => ({ key: d.date, label: d.label, date: d.date }))
      : resources.map((r) => ({ key: r.id, label: `${r.name}`, date: anchor, resourceId: r.id }));

  return (
    <AdminLayout>
      <Head><title>Diary - GreaseDesk</title></Head>

      <div className="bg-white text-slate-800 rounded-xl border border-slate-200 p-4 shadow">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-bold text-slate-900">Diary — {siteName}</h1>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-slate-300">
              <Link href={`/admin/diary?site=${siteId}&view=week&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'week' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>Week</Link>
              <Link href={`/admin/diary?site=${siteId}&view=day&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'day' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>Day</Link>
            </div>
            <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${prev}`} className="px-3 py-1.5 bg-slate-100 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-200">←</Link>
            <span className="px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800">{view === 'week' ? `Week of ${days[0]?.date}` : anchor}</span>
            <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${next}`} className="px-3 py-1.5 bg-slate-100 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-200">→</Link>
          </div>
        </div>

        {msg && <div className={`p-3 rounded-lg mb-4 text-sm ${msg.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{msg.text}</div>}

        {/* Placement form (light) */}
        <form onSubmit={place} className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4 flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Job card</label>
            <select value={jobCardId} onChange={(e) => setJobCardId(e.target.value)} className="p-2 bg-white border border-slate-300 rounded text-slate-800 text-sm min-w-[180px]">
              <option value="">Unscheduled… ({unscheduled.length})</option>
              {unscheduled.map((u) => <option key={u.id} value={u.id}>{u.reg} — {u.customer}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Resource</label>
            <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} className="p-2 bg-white border border-slate-300 rounded text-slate-800 text-sm">
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div><label className="block text-xs text-slate-500 mb-1">Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="p-2 bg-white border border-slate-300 rounded text-slate-800 text-sm" /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Start</label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="p-2 bg-white border border-slate-300 rounded text-slate-800 text-sm" /></div>
          <div><label className="block text-xs text-slate-500 mb-1">Hours</label><input type="number" step="0.5" min="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className="p-2 bg-white border border-slate-300 rounded text-slate-800 text-sm w-20" /></div>
          <button type="submit" className="bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">Place</button>
        </form>

        {resources.length === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 text-center text-slate-500">
            This location has no resources. Add some in Settings → Locations &amp; Resources.
          </div>
        ) : (
          <>
            {view === 'week' && !laneMode && (
              <p className="text-xs text-slate-500 mb-2">{resources.length} lifts — showing jobs as coloured dots (one colour per lift). Switch to Day view for full blocks.</p>
            )}
            <div className="overflow-x-auto">
              <div className="flex min-w-max">
                {/* Time axis */}
                <div className="w-16 shrink-0 pt-7">
                  {HOURS.map((h) => (
                    <div key={h} style={{ height: 60 * PX_PER_MIN }} className="text-xs text-slate-400 text-right pr-2 -mt-2">{String(h).padStart(2, '0')}:00</div>
                  ))}
                </div>
                {/* Columns */}
                {columns.map((col) => {
                  const colCards = cards.filter((c) => {
                    if (!segment(c, col.date)) return false;
                    if (view === 'day') return c.resourceId === (col as any).resourceId;
                    return true; // week: all location cards intersecting that day
                  });
                  const dotsMode = view === 'week' && !laneMode;
                  return (
                    <div key={col.key} className="w-52 shrink-0 border-l border-slate-200">
                      <div className="h-7 text-sm text-slate-700 text-center font-medium truncate px-1">{col.label}</div>
                      <div className="relative bg-white" style={{ height: WIN_MIN * PX_PER_MIN }}>
                        {HOURS.slice(1).map((h, i) => (
                          <div key={h} style={{ top: (i + 1) * 60 * PX_PER_MIN }} className="absolute left-0 right-0 border-t border-slate-100" />
                        ))}

                        {/* DOTS mode (week, >4 lifts) */}
                        {dotsMode && assignLanes(colCards.map((c) => { const sg = segment(c, col.date)!; return { ...sg, card: c }; }))
                          .map((x) => {
                            const colour = resolveColour(x.card.resourceColour);
                            return (
                              <Link
                                key={x.card.id}
                                href={`/admin/jobcards/${x.card.id}`}
                                title={tooltip(x.card)}
                                style={{ top: x.top, left: 4 + x.lane * 16, backgroundColor: colour }}
                                className="absolute w-3 h-3 rounded-full border border-white shadow ring-1 ring-black/10"
                              />
                            );
                          })}

                        {/* LANE/BLOCK mode (week ≤4 lifts, or day view) */}
                        {!dotsMode && colCards.map((c) => {
                          const sg = segment(c, col.date)!;
                          let left = '2px';
                          let width = 'calc(100% - 4px)';
                          if (view === 'week') {
                            const n = resources.length || 1;
                            const idx = laneIndex.get(c.resourceId) ?? 0;
                            const w = 100 / n;
                            left = `calc(${idx * w}% + 1px)`;
                            width = `calc(${w}% - 2px)`;
                          }
                          return <Block key={c.id} c={c} style={{ top: sg.top, height: sg.height, left, width }} />;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  const vis = await getVisibility(user.id as string);
  // Edge case: STANDARD user with no assigned sites (e.g. their only site was deleted).
  if (vis.siteIds.length === 0) {
    const today = ymd(new Date());
    return { props: { siteId: '', siteName: '', view: 'week', anchor: today, prev: today, next: today, days: [], resources: [], cards: [], unscheduled: [], noSites: true } };
  }

  // Resolve the requested site to one the caller may access (default to their first visible site).
  const wanted = (ctx.query.site as string) || user.site_id;
  const resolvedId = wanted && vis.siteIds.includes(wanted) ? wanted : vis.siteIds[0];
  const site = await prisma.site.findFirst({ where: { id: resolvedId }, select: { id: true, site_name: true } });
  if (!site) return { redirect: { destination: '/admin/diary', permanent: false } };

  const view: 'week' | 'day' = ctx.query.view === 'day' ? 'day' : 'week';
  const dateParam = (ctx.query.date as string) || '';
  const anchorObj = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00.000Z`) : new Date(`${ymd(new Date())}T00:00:00.000Z`);
  const anchor = ymd(anchorObj);

  let rangeStart: Date, rangeEnd: Date, days: DayCol[], prev: string, next: string;
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (view === 'week') {
    const dow = anchorObj.getUTCDay();
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

  type ResRow = { id: string; name: string; type: string; colour: string | null };
  type CardRow = { id: string; resource_id: string | null; start_at: Date | null; end_at: Date | null; resource: { name: string; colour: string | null } | null; vehicle: { registration: string | null } | null; customer: { name: string } | null };
  type UnRow = { id: string; vehicle: { registration: string | null } | null; customer: { name: string } | null };

  const [resourceRows, cardRows, unschedRows] = await Promise.all([
    prisma.resource.findMany({ where: { site_id: site.id, is_active: true }, orderBy: { display_order: 'asc' }, select: { id: true, name: true, type: true, colour: true } }) as Promise<ResRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, resource_id: { not: null }, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: { id: true, resource_id: true, start_at: true, end_at: true, resource: { select: { name: true, colour: true } }, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<CardRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, OR: [{ start_at: null }, { resource_id: null }], archived_at: null },
      orderBy: { created_at: 'desc' },
      select: { id: true, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<UnRow[]>,
  ]);

  const resources: ResourceCol[] = resourceRows.map((r: ResRow) => ({ id: r.id, name: r.name, type: r.type, colour: r.colour }));
  const cards: DiaryCard[] = cardRows.map((c: CardRow) => ({
    id: c.id,
    resourceId: c.resource_id as string,
    resourceName: c.resource?.name ?? '—',
    resourceColour: c.resource?.colour ?? null,
    reg: c.vehicle?.registration ?? '—',
    customer: c.customer?.name ?? '—',
    startAt: (c.start_at as Date).toISOString(),
    endAt: (c.end_at as Date).toISOString(),
  }));
  const unscheduled: UnscheduledCard[] = unschedRows.map((u: UnRow) => ({ id: u.id, reg: u.vehicle?.registration ?? '—', customer: u.customer?.name ?? '—' }));

  return { props: { siteId: site.id, siteName: site.site_name, view, anchor, prev, next, days, resources, cards, unscheduled } };
};
