/**
 * File: components/engine-room/NavManager.tsx
 * Navigation management inside the Content screen — define the marketing footer + main-nav links the
 * public SiteChrome renders from. Owner + Country Manager (the screen guard already blocks Support).
 * Add / edit / enable / reorder / delete links; each targets a document (slug), an internal route, or an
 * external URL. Region-scoped by country on the server.
 */
import { useCallback, useEffect, useState } from 'react';

type Link = { id: string; placement: string; label: string; kind: string; target: string; sort_order: number; country_code: string; enabled: boolean };
const input = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';
const hrefFor = (l: Link) => (l.kind === 'document' ? '/' + l.target.replace(/^\/+/, '') : l.target);

export default function NavManager() {
  const [links, setLinks] = useState<Link[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [nc, setNc] = useState({ placement: 'footer', label: '', kind: 'document', target: '', country: 'GB' });

  const load = useCallback(async () => { const r = await fetch('/api/superadmin/nav'); if (r.ok) setLinks((await r.json()).links); }, []);
  useEffect(() => { load(); }, [load]);
  async function call(method: string, body: any): Promise<boolean> {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/superadmin/nav', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false); setMsg({ ok: r.ok, text: d.message || (r.ok ? 'Done.' : 'Failed.') });
    if (r.ok) await load();
    return r.ok;
  }
  async function add() {
    if (!nc.label || !nc.target) { setMsg({ ok: false, text: 'Label and target required.' }); return; }
    if (await call('POST', nc)) setNc({ ...nc, label: '', target: '' });
  }
  const edit = (l: Link) => {
    const label = prompt('Label', l.label); if (label == null) return;
    const target = prompt(`Target (${l.kind === 'document' ? 'document slug' : l.kind === 'route' ? 'internal path' : 'external URL'})`, l.target); if (target == null) return;
    call('PATCH', { id: l.id, label, target });
  };
  async function move(l: Link, dir: -1 | 1) {
    const group = links.filter((x) => x.placement === l.placement).sort((a, b) => a.sort_order - b.sort_order);
    const i = group.findIndex((x) => x.id === l.id); const j = i + dir;
    if (j < 0 || j >= group.length) return;
    setBusy(true);
    await fetch('/api/superadmin/nav', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: l.id, sort_order: group[j].sort_order }) });
    await fetch('/api/superadmin/nav', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: group[j].id, sort_order: l.sort_order }) });
    setBusy(false); await load();
  }

  const Group = ({ placement }: { placement: string }) => {
    const rows = links.filter((l) => l.placement === placement).sort((a, b) => a.sort_order - b.sort_order);
    return (
      <div className="rounded-xl border border-slate-800 mb-5">
        <div className="bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 capitalize">{placement} nav</div>
        <table className="w-full text-sm">
          <tbody>
            {rows.length === 0 ? <tr><td className="px-4 py-3 text-slate-500">No links.</td></tr> : rows.map((l) => (
              <tr key={l.id} className={`border-t border-slate-800 ${l.enabled ? '' : 'opacity-50'}`}>
                <td className="px-4 py-2"><div className="text-white">{l.label}</div><div className="text-xs text-slate-500">{l.kind} · <span className="font-mono">{hrefFor(l)}</span></div></td>
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  <button disabled={busy} onClick={() => move(l, -1)} title="Move up" className="text-slate-400 hover:text-white px-1">↑</button>
                  <button disabled={busy} onClick={() => move(l, 1)} title="Move down" className="text-slate-400 hover:text-white px-1">↓</button>
                  <button disabled={busy} onClick={() => call('PATCH', { id: l.id, enabled: !l.enabled })} className="text-xs text-slate-400 hover:text-white px-2">{l.enabled ? 'Disable' : 'Enable'}</button>
                  <button disabled={busy} onClick={() => edit(l)} className="text-xs text-slate-300 hover:text-white px-2">Edit</button>
                  <button disabled={busy} onClick={() => { if (confirm(`Delete "${l.label}"?`)) call('DELETE', { id: l.id }); }} className="text-xs text-red-300 hover:text-red-200 px-2">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div>
      {msg && <div className={`mb-4 text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}
      <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900 p-4 flex flex-wrap items-end gap-2">
        <div><label className="block text-xs text-slate-400 mb-1">Placement</label><select value={nc.placement} onChange={(e) => setNc({ ...nc, placement: e.target.value })} className={input}><option value="footer">Footer</option><option value="main">Main</option></select></div>
        <div><label className="block text-xs text-slate-400 mb-1">Label</label><input value={nc.label} onChange={(e) => setNc({ ...nc, label: e.target.value })} className={input} /></div>
        <div><label className="block text-xs text-slate-400 mb-1">Kind</label><select value={nc.kind} onChange={(e) => setNc({ ...nc, kind: e.target.value })} className={input}><option value="document">Document</option><option value="route">Route</option><option value="external">External</option></select></div>
        <div><label className="block text-xs text-slate-400 mb-1">{nc.kind === 'document' ? 'Document slug' : nc.kind === 'route' ? 'Internal path' : 'External URL'}</label><input value={nc.target} onChange={(e) => setNc({ ...nc, target: e.target.value })} className={input} placeholder={nc.kind === 'document' ? 'privacy' : nc.kind === 'route' ? '/pricing' : 'https://…'} /></div>
        <div><label className="block text-xs text-slate-400 mb-1">Country</label><input value={nc.country} onChange={(e) => setNc({ ...nc, country: e.target.value.toUpperCase() })} maxLength={2} className={`${input} w-16`} /></div>
        <button disabled={busy} onClick={add} className="bg-slate-100 text-slate-900 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">Add link</button>
      </div>
      <Group placement="footer" />
      <Group placement="main" />
    </div>
  );
}
