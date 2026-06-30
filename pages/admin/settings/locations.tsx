/**
 * File: pages/admin/settings/locations.tsx
 * Settings → Locations & Resources. Manage Locations (Sites) and the Resources within each.
 * Operational structure: Group → Site (Location) → Resource. Tenant-scoped to the group.
 * Location CRUD via /api/locations; resource CRUD via /api/resources.
 *
 * NOTE (billing): adding a Location is a billable event (sites are billable units per CLAUDE.md).
 * Billing is not built; the hook is marked in /api/locations.ts (TODO(billing)).
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { RESOURCE_PALETTE, resolveColour } from '@/lib/diary-colours';
import { requireSiteManagerPage } from '@/lib/admin-guard';

const RESOURCE_TYPE_OPTIONS = [
  { value: 'lift', label: 'Lift' },
  { value: 'mot_bay', label: 'MOT Bay' },
  { value: 'spray_booth', label: 'Spray Booth' },
];
const typeLabel = (v: string) => RESOURCE_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;

type ResourceView = { id: string; name: string; type: string; display_order: number; is_active: boolean; colour: string | null };
type LocationView = {
  id: string;
  name: string;
  address: string | null;
  isActive: boolean;
  isCurrent: boolean;
  resources: ResourceView[];
};
type PageProps = { locations: LocationView[]; isAdmin: boolean; isManager: boolean };

const inputClass = 'p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';

async function mutate(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch {
    return 'Network error.';
  }
}

// --- Resource row (edit / delete) ---
function ResourceRow({ resource, onChanged }: { resource: ResourceView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
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
  async function setColour(colour: string | null) {
    const error = await mutate('/api/resources', 'PATCH', { id: resource.id, colour });
    if (error) return setErr(error);
    setPicking(false);
    onChanged();
  }

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2 border-t border-line">
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-40`} />
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
          {RESOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input value={order} onChange={(e) => setOrder(e.target.value)} type="number" className={`${inputClass} w-20`} title="Display order" />
        <button onClick={save} className="text-xs bg-ok hover:bg-ok text-white rounded px-3 py-1.5">Save</button>
        <button onClick={() => setEditing(false)} className="text-xs text-muted hover:text-ink px-2">Cancel</button>
        {err && <span className="text-danger text-xs">{err}</span>}
      </div>
    );
  }
  return (
    <div className="py-2 border-t border-line text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center">
          {/* Current colour swatch — click to pick */}
          <button
            onClick={() => setPicking((v) => !v)}
            title="Set lift colour"
            className="w-4 h-4 rounded-sm border border-line mr-2 shrink-0"
            style={{ backgroundColor: resolveColour(resource.colour) }}
          />
          <span className="font-medium text-ink">{resource.name}</span>
          <span className="text-muted ml-2">· {typeLabel(resource.type)}</span>
          <span className="text-muted ml-2">· order {resource.display_order}</span>
          {!resource.is_active && <span className="text-warn ml-2">· inactive</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setEditing(true)} className="text-xs text-accent hover:underline">Edit</button>
          <button onClick={remove} className="text-xs text-danger hover:underline">Remove</button>
          {err && <span className="text-danger text-xs">{err}</span>}
        </div>
      </div>
      {picking && (
        <div className="flex items-center flex-wrap gap-1.5 mt-2 ml-6">
          {RESOURCE_PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setColour(c)}
              title={c}
              className={`w-5 h-5 rounded-full border ${resource.colour === c ? 'border-white ring-2 ring-white/50' : 'border-line'}`}
              style={{ backgroundColor: c }}
            />
          ))}
          <button onClick={() => setColour(null)} className="text-xs text-muted hover:text-ink ml-1 underline">Default</button>
        </div>
      )}
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
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-line">
      <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Resource (e.g. Lift 2)" className={`${inputClass} flex-1 min-w-[140px]`} />
      <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
        {RESOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <input value={order} onChange={(e) => setOrder(e.target.value)} type="number" className={`${inputClass} w-20`} title="Display order" />
      <button type="submit" disabled={busy} className="text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded px-3 py-1.5 disabled:opacity-50">
        {busy ? 'Adding…' : '+ Resource'}
      </button>
      {err && <span className="text-danger text-xs">{err}</span>}
    </form>
  );
}

// --- Add a Location (Site) ---
function AddLocation({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/locations', 'POST', { site_name: name, address });
    setBusy(false);
    if (error) return setErr(error);
    setName('');
    setAddress('');
    onChanged();
  }
  return (
    <form onSubmit={submit} className="bg-surface border border-line rounded-xl p-4 mb-6 flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-muted mb-1">New location name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Great Bridge" className={`${inputClass} w-full`} />
      </div>
      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-muted mb-1">Address (optional)</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} className={`${inputClass} w-full`} />
      </div>
      <button type="submit" disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
        {busy ? 'Adding…' : 'Add Location'}
      </button>
      {err && <p className="text-danger text-xs w-full">{err}</p>}
      <p className="text-xs text-muted w-full">A new location starts with no resources. Note: locations are billable — adding one will affect billing once that module exists.</p>
    </form>
  );
}

// --- Location card (edit / delete + its resources) ---
function LocationCard({ loc, isAdmin, onChanged }: { loc: LocationView; isAdmin: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(loc.name);
  const [address, setAddress] = useState(loc.address ?? '');
  const [active, setActive] = useState(loc.isActive);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const error = await mutate('/api/locations', 'PATCH', { id: loc.id, site_name: name, address, is_active: active });
    if (error) return setErr(error);
    setEditing(false);
    onChanged();
  }
  async function remove() {
    const error = await mutate('/api/locations', 'DELETE', { id: loc.id });
    if (error) return setErr(error); // e.g. 409 guard (has data / current / last)
    onChanged();
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5 mb-4">
      <div className="flex items-start justify-between">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} w-44`} placeholder="Name" />
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={`${inputClass} w-56`} placeholder="Address" />
            <label className="text-xs text-muted flex items-center gap-1">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
            </label>
            <button onClick={save} className="text-xs bg-ok hover:bg-ok text-white rounded px-3 py-1.5">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-muted hover:text-ink px-2">Cancel</button>
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-semibold text-ink">
              {loc.name}
              {loc.isCurrent && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent border border-accent align-middle">current</span>}
              {!loc.isActive && <span className="ml-2 text-xs text-warn align-middle">inactive</span>}
            </h2>
            {loc.address && <p className="text-muted text-sm mt-0.5">{loc.address}</p>}
          </div>
        )}
        {/* Editing/removing a location is admin-only; site managers manage resources below. */}
        {!editing && isAdmin && (
          <div className="flex items-center gap-3">
            <button onClick={() => setEditing(true)} className="text-xs text-accent hover:underline">Edit</button>
            <button onClick={remove} className="text-xs text-danger hover:underline">Remove</button>
          </div>
        )}
      </div>
      {err && <p className="text-danger text-xs mt-1">{err}</p>}

      <div className="mt-4">
        <div className="text-xs uppercase text-muted">Resources</div>
        {loc.resources.length === 0 && <p className="text-muted text-sm py-2">No resources yet.</p>}
        {loc.resources.map((r) => <ResourceRow key={r.id} resource={r} onChanged={onChanged} />)}
        <AddResource siteId={loc.id} onChanged={onChanged} />
      </div>
    </div>
  );
}

export default function LocationsSettings({ locations, isAdmin, isManager }: PageProps) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);

  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
      <Head><title>Locations & Resources - GreaseDesk</title></Head>
      <p className="text-muted mb-6">Your locations and each location’s physical resources (lifts, MOT bays, spray booths). Resources become the diary’s columns.</p>

      {/* Adding a (billable) location is admin-only. */}
      {isAdmin && <AddLocation onChanged={refresh} />}

      {locations.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-8 text-center text-muted">
          You’re not currently assigned to a location — contact your admin.
        </div>
      ) : (
        locations.map((loc) => <LocationCard key={loc.id} loc={loc} isAdmin={isAdmin} onChanged={refresh} />)
      )}
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  // ADMIN or SITE_MANAGER only — STANDARD users have no Locations & Resources access.
  const gate = await requireSiteManagerPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;

  type ResDbRow = { id: string; name: string; type: string; display_order: number; is_active: boolean; colour: string | null };
  type SiteDbRow = { id: string; site_name: string; address: string | null; is_active: boolean; resources: ResDbRow[] };

  const sites = (await prisma.site.findMany({
    where: { id: { in: vis.siteIds } }, // visible sites only
    orderBy: { site_name: 'asc' },
    include: { resources: { orderBy: { display_order: 'asc' } } },
  })) as SiteDbRow[];

  const locations: LocationView[] = sites.map((s: SiteDbRow) => ({
    id: s.id,
    name: s.site_name,
    address: s.address,
    isActive: s.is_active,
    isCurrent: s.id === user.site_id,
    resources: s.resources.map((r: ResDbRow) => ({ id: r.id, name: r.name, type: r.type, display_order: r.display_order, is_active: r.is_active, colour: r.colour })),
  }));

  return { props: { locations, isAdmin: vis.isAdmin, isManager: vis.role === 'SITE_MANAGER' } };
};
