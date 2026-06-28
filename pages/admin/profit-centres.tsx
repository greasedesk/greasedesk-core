/**
 * File: pages/admin/profit-centres.tsx
 * Slice: Profit Centres & Resources admin for a single Site.
 *
 * SSR read scoped to the session's site_id (ownership-checked group_id), mirroring
 * the Settings page. Mutations go through /api/profit-centres and /api/resources;
 * after each, we re-run SSR via router.replace(router.asPath) to refresh.
 * Single-site only — multi-site UI is a later slice.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';

const CATEGORY_OPTIONS = [
  { value: 'repairs', label: 'Repairs' },
  { value: 'mot', label: 'MOT' },
  { value: 'spraybooth', label: 'Spraybooth' },
  { value: 'car_sales', label: 'Car Sales' },
];
const RESOURCE_TYPE_OPTIONS = [
  { value: 'lift', label: 'Lift' },
  { value: 'mot_bay', label: 'MOT Bay' },
  { value: 'spray_booth', label: 'Spray Booth' },
];
const categoryLabel = (v: string | null) =>
  CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? (v ?? '—');
const resourceTypeLabel = (v: string) =>
  RESOURCE_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;

type ResourceView = { id: string; name: string; type: string; display_order: number; is_active: boolean };
type ProfitCentreView = {
  id: string;
  name: string;
  category: string | null;
  is_active: boolean;
  resources: ResourceView[];
};
type PageProps = { siteName: string; profitCentres: ProfitCentreView[] };

const inputClass =
  'p-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:ring-blue-500 focus:border-blue-500';

// Shared mutation helper: returns error message string or null on success.
async function mutate(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data?.message || 'Request failed.';
    return null;
  } catch {
    return 'Network error.';
  }
}

function ErrorText({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="text-red-400 text-xs mt-1">{msg}</p>;
}

// --- Add Profit Centre ---
function AddProfitCentre({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('repairs');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/profit-centres', 'POST', { name, category });
    setBusy(false);
    if (error) return setErr(error);
    setName('');
    setCategory('repairs');
    onChanged();
  }

  return (
    <form onSubmit={submit} className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6 flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-slate-400 mb-1">New profit centre name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Repairs" className={`${inputClass} w-full`} />
      </div>
      <div>
        <label className="block text-xs text-slate-400 mb-1">Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={busy} className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
        {busy ? 'Adding…' : 'Add Profit Centre'}
      </button>
      <ErrorText msg={err} />
    </form>
  );
}

// --- Resource row (edit / delete) ---
function ResourceRow({ resource, onChanged }: { resource: ResourceView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(resource.name);
  const [type, setType] = useState(resource.type);
  const [order, setOrder] = useState(String(resource.display_order));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/resources', 'PATCH', { id: resource.id, name, type, display_order: order });
    setBusy(false);
    if (error) return setErr(error);
    setEditing(false);
    onChanged();
  }
  async function remove() {
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/resources', 'DELETE', { id: resource.id });
    setBusy(false);
    if (error) return setErr(error);
    onChanged();
  }

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2 border-t border-slate-700">
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-40`} />
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
          {RESOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input value={order} onChange={(e) => setOrder(e.target.value)} type="number" className={`${inputClass} w-20`} title="Display order" />
        <button onClick={save} disabled={busy} className="text-xs bg-green-600 hover:bg-green-500 text-white rounded px-3 py-1.5">Save</button>
        <button onClick={() => setEditing(false)} className="text-xs text-slate-400 hover:text-white px-2">Cancel</button>
        <ErrorText msg={err} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 border-t border-slate-700 text-sm">
      <div>
        <span className="font-medium text-slate-100">{resource.name}</span>
        <span className="text-slate-400 ml-2">· {resourceTypeLabel(resource.type)}</span>
        <span className="text-slate-500 ml-2">· order {resource.display_order}</span>
        {!resource.is_active && <span className="text-amber-400 ml-2">· inactive</span>}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => setEditing(true)} className="text-xs text-blue-400 hover:underline">Edit</button>
        <button onClick={remove} disabled={busy} className="text-xs text-red-400 hover:underline">Remove</button>
        <ErrorText msg={err} />
      </div>
    </div>
  );
}

// --- Add resource (within a profit centre) ---
function AddResource({ profitCentreId, onChanged }: { profitCentreId: string; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('lift');
  const [order, setOrder] = useState('0');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/resources', 'POST', { profit_centre_id: profitCentreId, name, type, display_order: order });
    setBusy(false);
    if (error) return setErr(error);
    setName('');
    setType('lift');
    setOrder('0');
    onChanged();
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-slate-700">
      <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Resource name (e.g. Lift 2)" className={`${inputClass} flex-1 min-w-[140px]`} />
      <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
        {RESOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <input value={order} onChange={(e) => setOrder(e.target.value)} type="number" className={`${inputClass} w-20`} title="Display order" />
      <button type="submit" disabled={busy} className="text-xs bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded px-3 py-1.5 disabled:opacity-50">
        {busy ? 'Adding…' : '+ Resource'}
      </button>
      <ErrorText msg={err} />
    </form>
  );
}

// --- Profit centre card (edit / delete + its resources) ---
function ProfitCentreCard({ pc, onChanged }: { pc: ProfitCentreView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pc.name);
  const [category, setCategory] = useState(pc.category ?? 'repairs');
  const [active, setActive] = useState(pc.is_active);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/profit-centres', 'PATCH', { id: pc.id, name, category, is_active: active });
    setBusy(false);
    if (error) return setErr(error);
    setEditing(false);
    onChanged();
  }
  async function remove() {
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/profit-centres', 'DELETE', { id: pc.id });
    setBusy(false);
    if (error) return setErr(error); // e.g. 409 "used by N job cards — deactivate instead"
    onChanged();
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 mb-4">
      <div className="flex items-start justify-between">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-44`} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
              {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <label className="text-xs text-slate-300 flex items-center gap-1">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
            </label>
            <button onClick={save} disabled={busy} className="text-xs bg-green-600 hover:bg-green-500 text-white rounded px-3 py-1.5">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-slate-400 hover:text-white px-2">Cancel</button>
          </div>
        ) : (
          <div>
            <h3 className="text-lg font-semibold text-white">
              {pc.name}
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-900 text-blue-200 border border-blue-700 align-middle">
                {categoryLabel(pc.category)}
              </span>
              {!pc.is_active && <span className="ml-2 text-xs text-amber-400 align-middle">inactive</span>}
            </h3>
          </div>
        )}
        {!editing && (
          <div className="flex items-center gap-3">
            <button onClick={() => setEditing(true)} className="text-xs text-blue-400 hover:underline">Edit</button>
            <button onClick={remove} disabled={busy} className="text-xs text-red-400 hover:underline">Remove</button>
          </div>
        )}
      </div>
      <ErrorText msg={err} />

      <div className="mt-4">
        <div className="text-xs uppercase text-slate-400">Resources</div>
        {pc.resources.length === 0 && <p className="text-slate-500 text-sm py-2">No resources yet.</p>}
        {pc.resources.map((r) => (
          <ResourceRow key={r.id} resource={r} onChanged={onChanged} />
        ))}
        <AddResource profitCentreId={pc.id} onChanged={onChanged} />
      </div>
    </div>
  );
}

export default function ProfitCentresPage({ siteName, profitCentres }: PageProps) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);

  return (
    <AdminLayout>
      <Head>
        <title>Profit Centres & Resources - GreaseDesk</title>
      </Head>

      <h1 className="text-3xl font-bold text-white mb-1">Profit Centres &amp; Resources</h1>
      <p className="text-slate-400 mb-6">Configure the functional areas and physical resources for <strong>{siteName}</strong>.</p>

      <AddProfitCentre onChanged={refresh} />

      {profitCentres.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center text-slate-400">
          No profit centres yet. Add the first one above.
        </div>
      ) : (
        profitCentres.map((pc) => <ProfitCentreCard key={pc.id} pc={pc} onChanged={refresh} />)
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

  type ResDbRow = { id: string; name: string; type: string; display_order: number; is_active: boolean };
  type PcDbRow = { id: string; name: string; category: string | null; is_active: boolean; resources: ResDbRow[] };

  const [site, rows] = await Promise.all([
    prisma.site.findFirst({
      where: { id: user.site_id, group_id: user.group_id }, // tenant scope
      select: { site_name: true },
    }),
    prisma.profitCentre.findMany({
      where: { site_id: user.site_id }, // tenant scope (site is the caller's)
      orderBy: { name: 'asc' },
      include: { resources: { orderBy: { display_order: 'asc' } } },
    }) as Promise<PcDbRow[]>,
  ]);

  const profitCentres: ProfitCentreView[] = rows.map((p: PcDbRow) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    is_active: p.is_active,
    resources: p.resources.map((r: ResDbRow) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      display_order: r.display_order,
      is_active: r.is_active,
    })),
  }));

  return { props: { siteName: site?.site_name ?? 'this site', profitCentres } };
};
