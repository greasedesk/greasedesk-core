/**
 * File: pages/admin/diary.tsx
 * Per-location diary. Columns = the location's active Resources (ordered by display_order),
 * rows = 4 fixed time slots. Place an unscheduled job card on a resource+slot (guarded against
 * double-booking by /api/diary). Location chosen via ?site=, day via ?date=.
 * Tenant-scoped: site must belong to the caller's group; cards placed on their own site only.
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

const SLOTS = [
  { i: 0, label: '09:00–11:00' },
  { i: 1, label: '11:00–13:00' },
  { i: 2, label: '14:00–16:00' },
  { i: 3, label: '16:00–18:00' },
];

type ResourceCol = { id: string; name: string; type: string };
type PlacedCard = { id: string; resourceId: string; startSlot: number; endSlot: number; reg: string; customer: string; status: string };
type UnscheduledCard = { id: string; reg: string; customer: string };
type PageProps = {
  siteId: string;
  siteName: string;
  date: string;
  prevDate: string;
  nextDate: string;
  resources: ResourceCol[];
  placed: PlacedCard[];
  unscheduled: UnscheduledCard[];
};

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function DiaryPage({ siteId, siteName, date, prevDate, nextDate, resources, placed, unscheduled }: PageProps) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  const [msg, setMsg] = useState<{ text: string; type: 'error' | 'success' } | null>(null);
  const [openCell, setOpenCell] = useState<string | null>(null); // `${resourceId}:${slot}`

  // Lookup: which card occupies a given resource+slot.
  const cellCard = (resourceId: string, slot: number) =>
    placed.find((p) => p.resourceId === resourceId && p.startSlot <= slot && p.endSlot >= slot);

  async function place(jobCardId: string, resourceId: string, slot: number) {
    setMsg(null);
    const res = await fetch('/api/diary', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobCardId, resourceId, date, startSlot: slot, endSlot: slot }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg({ text: data?.message || 'Failed to place job card.', type: 'error' });
      return;
    }
    setOpenCell(null);
    setMsg({ text: 'Job card placed.', type: 'success' });
    refresh();
  }

  async function unplace(jobCardId: string) {
    setMsg(null);
    const res = await fetch(`/api/diary?jobCardId=${jobCardId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMsg({ text: data?.message || 'Failed to unplace.', type: 'error' });
      return;
    }
    refresh();
  }

  return (
    <AdminLayout>
      <Head><title>Diary - GreaseDesk</title></Head>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-3xl font-bold text-white">Diary — {siteName}</h1>
        <div className="flex items-center gap-2">
          <Link href={`/admin/diary?site=${siteId}&date=${prevDate}`} className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm text-slate-200 hover:bg-slate-600">← Prev</Link>
          <Link href={`/admin/diary?site=${siteId}&date=${ymdToday()}`} className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm text-slate-200 hover:bg-slate-600">Today</Link>
          <span className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-medium">{date}</span>
          <Link href={`/admin/diary?site=${siteId}&date=${nextDate}`} className="px-3 py-1.5 bg-slate-700 rounded-lg text-sm text-slate-200 hover:bg-slate-600">Next →</Link>
        </div>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg mb-4 text-sm ${msg.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>
          {msg.text}
        </div>
      )}

      {resources.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center text-slate-400">
          This location has no resources. Add some in Settings → Locations &amp; Resources.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="border-collapse">
            <thead>
              <tr>
                <th className="p-2 text-xs uppercase text-slate-500 text-left w-28">Slot</th>
                {resources.map((r) => (
                  <th key={r.id} className="p-2 text-sm text-white text-left min-w-[180px] border-b border-slate-700">
                    {r.name} <span className="text-slate-500 text-xs">({r.type})</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SLOTS.map((slot) => (
                <tr key={slot.i}>
                  <td className="p-2 text-xs text-slate-400 align-top whitespace-nowrap">{slot.label}</td>
                  {resources.map((r) => {
                    const card = cellCard(r.id, slot.i);
                    const key = `${r.id}:${slot.i}`;
                    return (
                      <td key={key} className="p-1 align-top border border-slate-800">
                        {card ? (
                          <div className="bg-slate-700 border border-slate-600 rounded-lg p-2 text-sm">
                            <div className="font-semibold text-white">{card.reg}</div>
                            <div className="text-slate-300 text-xs">{card.customer}</div>
                            <div className="flex items-center justify-between mt-1">
                              <span className="text-xs text-slate-400 capitalize">{card.status}</span>
                              <button onClick={() => unplace(card.id)} className="text-xs text-red-400 hover:underline">Unplace</button>
                            </div>
                          </div>
                        ) : openCell === key ? (
                          <div className="p-1">
                            <select
                              autoFocus
                              defaultValue=""
                              onChange={(e) => e.target.value && place(e.target.value, r.id, slot.i)}
                              className="w-full p-1.5 bg-slate-700 border border-slate-600 rounded text-white text-xs"
                            >
                              <option value="" disabled>Pick a job card…</option>
                              {unscheduled.map((u) => (
                                <option key={u.id} value={u.id}>{u.reg} — {u.customer}</option>
                              ))}
                            </select>
                            <button onClick={() => setOpenCell(null)} className="text-xs text-slate-400 hover:text-white mt-1">Cancel</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setMsg(null); setOpenCell(key); }}
                            className="w-full h-14 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded-lg text-sm"
                          >
                            + Place
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 text-sm text-slate-400">
        Unscheduled job cards at this location: <span className="text-slate-200 font-medium">{unscheduled.length}</span>
        {unscheduled.length === 0 && ' — create one in Job Cards, or they may all be placed.'}
      </div>
    </AdminLayout>
  );
}

// Client-side "today" for the Today button (avoids SSR/CSR drift on the label only).
function ymdToday() {
  return new Date().toISOString().slice(0, 10);
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  const groupId = user.group_id as string;

  // Selected location (must belong to the group); fall back to the session site.
  const requestedSite = (ctx.query.site as string) || user.site_id;
  const site = await prisma.site.findFirst({ where: { id: requestedSite, group_id: groupId }, select: { id: true, site_name: true } });
  if (!site) {
    return { redirect: { destination: '/admin/diary', permanent: false } };
  }

  // Day
  const dateParam = (ctx.query.date as string) || '';
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateParam);
  const dateObj = valid ? new Date(`${dateParam}T00:00:00.000Z`) : new Date(`${ymd(new Date())}T00:00:00.000Z`);
  const date = ymd(dateObj);
  const prevDate = ymd(new Date(dateObj.getTime() - 86400000));
  const nextDate = ymd(new Date(dateObj.getTime() + 86400000));

  type ResRow = { id: string; name: string; type: string };
  type PlacedRow = { id: string; resource_id: string | null; start_slot: number | null; end_slot: number | null; status: string; vehicle: { registration: string | null } | null; customer: { name: string } | null };
  type UnRow = { id: string; vehicle: { registration: string | null } | null; customer: { name: string } | null };

  const [resourceRows, placedRows, unschedRows] = await Promise.all([
    prisma.resource.findMany({ where: { site_id: site.id, is_active: true }, orderBy: { display_order: 'asc' }, select: { id: true, name: true, type: true } }) as Promise<ResRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, scheduled_date: dateObj, resource_id: { not: null } },
      select: { id: true, resource_id: true, start_slot: true, end_slot: true, status: true, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<PlacedRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, resource_id: null, archived_at: null },
      orderBy: { created_at: 'desc' },
      select: { id: true, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
    }) as Promise<UnRow[]>,
  ]);

  const resources: ResourceCol[] = resourceRows.map((r: ResRow) => ({ id: r.id, name: r.name, type: r.type }));
  const placed: PlacedCard[] = placedRows.map((p: PlacedRow) => ({
    id: p.id,
    resourceId: p.resource_id as string,
    startSlot: p.start_slot ?? 0,
    endSlot: p.end_slot ?? 0,
    reg: p.vehicle?.registration ?? '—',
    customer: p.customer?.name ?? '—',
    status: p.status,
  }));
  const unscheduled: UnscheduledCard[] = unschedRows.map((u: UnRow) => ({ id: u.id, reg: u.vehicle?.registration ?? '—', customer: u.customer?.name ?? '—' }));

  return { props: { siteId: site.id, siteName: site.site_name, date, prevDate, nextDate, resources, placed, unscheduled } };
};
