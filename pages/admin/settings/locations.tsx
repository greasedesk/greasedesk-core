/**
 * File: pages/admin/settings/locations.tsx
 * Settings → Locations & Resources. Operational structure: each Location (Site) has
 * Resources (lifts / MOT bays / spray booths). Resource CRUD via /api/resources.
 * Lists all locations in the caller's group (HQ visibility); adding new locations is a
 * later slice — this manages resources within existing locations.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';

const RESOURCE_TYPE_OPTIONS = [
  { value: 'lift', label: 'Lift' },
  { value: 'mot_bay', label: 'MOT Bay' },
  { value: 'spray_booth', label: 'Spray Booth' },
];
const typeLabel = (v: string) => RESOURCE_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;

type ResourceView = { id: string; name: string; type: string; display_order: number; is_active: boolean };
type LocationView = { id: string; name: string; isCurrent: boolean; resources: ResourceView[] };
type PageProps = { locations: LocationView[] };

const inputClass = 'p-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:ring-blue-500 focus:border-blue-500';

async function mutate(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch {
    return 'Network error.';
  }
}

function ResourceRow({ resource, onChanged }: { resource: ResourceView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(resource.name);
  const [type, setType] = useState(resource.type);
  const [order, setOrder] = useState(String(resource.display_order));
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const error = await mutate('/api/resources', 'PATCH', { id: resource.id, name, type, display_order: order });
    if (error) return setErr(error);
    setEditing(false);
    onChanged();
  }
  async function remove() {
    const error = await mutate('/api/resources', 'DELETE', { id: resource.id });
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
        <button onClick={save} className="text-xs bg-green-600 hover:bg-green-500 text-white rounded px-3 py-1.5">Save</button>
        <button onClick={() => setEditing(false)} className="text-xs text-slate-400 hover:text-white px-2">Cancel</button>
        {err && <span className="text-red-400 text-xs">{err}</span>}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-2 border-t border-slate-700 text-sm">
      <div>
        <span className="font-medium text-slate-100">{resource.name}</span>
        <span className="text-slate-400 ml-2">· {typeLabel(resource.type)}</span>
        <span className="text-slate-500 ml-2">· order {resource.display_order}</span>
        {!resource.is_active && <span className="text-amber-400 ml-2">· inactive</span>}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => setEditing(true)} className="text-xs text-blue-400 hover:underline">Edit</button>
        <button onClick={remove} className="text-xs text-red-400 hover:underline">Remove</button>
        {err && <span className="text-red-400 text-xs">{err}</span>}
      </div>
    </div>
  );
}

function AddResource({ siteId, onChanged }: { siteId: string; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('lift');
  const [order, setOrder] = useState('0');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/resources', 'POST', { site_id: siteId, name, type, display_order: order });
    setBusy(false);
    if (error) return setErr(error);
    setName('');
    setType('lift');
    setOrder('0');
    onChanged();
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-slate-700">
      <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Resource (e.g. Lift 2)" className={`${inputClass} flex-1 min-w-[140px]`} />
      <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
        {RESOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <input value={order} onChange={(e) => setOrder(e.target.value)} type="number" className={`${inputClass} w-20`} title="Display order" />
      <button type="submit" disabled={busy} className="text-xs bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded px-3 py-1.5 disabled:opacity-50">
        {busy ? 'Adding…' : '+ Resource'}
      </button>
      {err && <span className="text-red-400 text-xs">{err}</span>}
    </form>
  );
}

export default function LocationsSettings({ locations }: PageProps) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);

  return (
    <SettingsLayout>
      <Head><title>Locations & Resources - GreaseDesk</title></Head>
      <p className="text-slate-400 mb-6">Each location’s physical resources (lifts, MOT bays, spray booths). These become the diary’s columns.</p>

      {locations.map((loc) => (
        <div key={loc.id} className="bg-slate-800 border border-slate-700 rounded-xl p-5 mb-4">
          <h2 className="text-lg font-semibold text-white">
            {loc.name}
            {loc.isCurrent && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-900 text-blue-200 border border-blue-700">current</span>}
          </h2>
          <div className="mt-3">
            <div className="text-xs uppercase text-slate-400">Resources</div>
            {loc.resources.length === 0 && <p className="text-slate-500 text-sm py-2">No resources yet.</p>}
            {loc.resources.map((r) => <ResourceRow key={r.id} resource={r} onChanged={refresh} />)}
            <AddResource siteId={loc.id} onChanged={refresh} />
          </div>
        </div>
      ))}
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  type ResDbRow = { id: string; name: string; type: string; display_order: number; is_active: boolean };
  type SiteDbRow = { id: string; site_name: string; resources: ResDbRow[] };

  const sites = (await prisma.site.findMany({
    where: { group_id: user.group_id }, // HQ visibility across the group's locations
    orderBy: { site_name: 'asc' },
    include: { resources: { orderBy: { display_order: 'asc' } } },
  })) as SiteDbRow[];

  const locations: LocationView[] = sites.map((s: SiteDbRow) => ({
    id: s.id,
    name: s.site_name,
    isCurrent: s.id === user.site_id,
    resources: s.resources.map((r: ResDbRow) => ({ id: r.id, name: r.name, type: r.type, display_order: r.display_order, is_active: r.is_active })),
  }));

  return { props: { locations } };
};
