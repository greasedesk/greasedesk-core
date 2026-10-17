/**
 * File: components/products/CatalogueSetsSection.tsx
 * NAMED SETS OF PRODUCTS — the authoring surface.
 *
 * ── WHAT A GARAGE IS ACTUALLY DOING HERE ───────────────────────────────────────────────────────
 * Naming a group of products and saying how they are offered. "Oil Services" holds Bronze, Silver,
 * Gold and Platinum and the customer takes ONE. "Service items" holds the MOT, the brake fluid
 * flush, the aircon regas, and the customer takes ANY NUMBER. That difference is the whole screen,
 * so it is a two-way choice made when the set is created and visible on every row afterwards —
 * never a checkbox buried in an editor.
 *
 * ── ORDER IS DRAG-FREE, DELIBERATELY ───────────────────────────────────────────────────────────
 * Up/down buttons, not drag-and-drop. The ladder order matters (Bronze reads before Platinum) and
 * a keyboard-reachable control that works first time beats a drag handle that needs a second
 * attempt on a trackpad in a workshop. Position is sent as the array index, so what you see is
 * what is stored.
 */
import { useEffect, useMemo, useState } from 'react';

type Product = { id: string; code: string; title: string | null; name: string; itemType: string };
type Member = { id: string; catalogueItemId: string; position: number };
type Set_ = { id: string; name: string; shape: 'pick_one' | 'base_plus_extras'; position: number; active: boolean; members: Member[] };

const SHAPE_LABEL: Record<Set_['shape'], string> = {
  pick_one: 'Choose one',
  base_plus_extras: 'Take any number',
};
const SHAPE_HINT: Record<Set_['shape'], string> = {
  pick_one: 'An upsell ladder. Taking one means not taking the others, and the order is the order the customer reads.',
  base_plus_extras: 'A menu. Any number can be taken, in any combination.',
};

export default function CatalogueSetsSection({ products }: { products: Product[] }) {
  const [sets, setSets] = useState<Set_[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [newShape, setNewShape] = useState<Set_['shape']>('pick_one');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const label = (id: string) => { const p = byId.get(id); return p ? (p.title || p.name || p.code) : '(removed product)'; };

  async function load() {
    const r = await fetch('/api/catalogue-sets', { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    setSets(d.sets ?? []); setLoaded(true);
  }
  useEffect(() => { void load(); }, []);

  /** Every write goes through here, so the refusal the SERVER sends is what the screen shows —
   *  never a cheerful local guess about what probably happened. */
  async function send(method: string, body: unknown, key: string, url = '/api/catalogue-sets') {
    setBusy(key); setMsg(null);
    try {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === null ? undefined : JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: d?.message || 'That did not save.' }); return false; }
      await load();
      return true;
    } catch {
      setMsg({ ok: false, text: 'That did not save.' });
      return false;
    } finally { setBusy(null); }
  }

  const saveMembers = (s: Set_, members: Member[]) =>
    send('PATCH', { id: s.id, members: members.map((m, i) => ({ catalogueItemId: m.catalogueItemId, position: i })) }, `m-${s.id}`);

  const move = (s: Set_, i: number, by: number) => {
    const next = [...s.members];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    void saveMembers(s, next);
  };

  return (
    <details className="bg-surface border border-line rounded-xl p-4 mb-4" data-testid="catalogue-sets">
      <summary className="cursor-pointer text-ink font-semibold">Product sets<span className="ml-2 text-xs font-normal text-muted">{loaded ? `${sets.length}` : '…'}</span></summary>

      <p className="text-xs text-muted mt-3">
        A named group of products, and how they are offered. On a quote, dropping the ladder icon on
        a line whose product is in a “{SHAPE_LABEL.pick_one}” set offers the rest of that set with
        their prices — which is the only way the builder can reach a product that is not already on
        the estimate.
      </p>

      {msg && <div className={`mt-3 p-2 rounded text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`} data-testid="sets-msg">{msg.text}</div>}

      {/* CREATE */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Set name, e.g. Oil Services" maxLength={80}
          data-testid="set-name" className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink" style={{ minWidth: 220 }} />
        <select value={newShape} onChange={(e) => setNewShape(e.target.value as Set_['shape'])} data-testid="set-shape"
          className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
          <option value="pick_one">{SHAPE_LABEL.pick_one}</option>
          <option value="base_plus_extras">{SHAPE_LABEL.base_plus_extras}</option>
        </select>
        <button data-testid="set-create" disabled={busy !== null || !newName.trim()}
          onClick={async () => { if (await send('POST', { name: newName.trim(), shape: newShape }, 'new')) setNewName(''); }}
          className="text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">Create set</button>
        <span className="text-xs text-muted basis-full">{SHAPE_HINT[newShape]}</span>
      </div>

      {/* THE SETS */}
      {loaded && sets.length === 0 && <p className="text-sm text-muted mt-4" data-testid="no-sets">No sets yet.</p>}
      <div className="mt-4 space-y-3">
        {sets.map((s) => {
          const open = openId === s.id;
          const inSet = new Set(s.members.map((m) => m.catalogueItemId));
          const candidates = products.filter((p) => !inSet.has(p.id));
          return (
            <div key={s.id} className="border border-line rounded-lg p-3" data-testid="set-row" data-set={s.id} data-shape={s.shape}>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => setOpenId(open ? null : s.id)} className="text-sm font-semibold text-ink" data-testid="set-open">
                  {open ? '▾' : '▸'} {s.name}
                </button>
                {/* THE SHAPE IS ON THE FACE OF THE ROW. It decides whether taking one excludes the
                    others, which is too consequential to live only inside an editor. */}
                <span className="text-xs rounded-full px-2 py-0.5 bg-surface-muted text-muted" data-testid="set-shape-badge">{SHAPE_LABEL[s.shape]}</span>
                <span className="text-xs text-muted">{s.members.length} product{s.members.length === 1 ? '' : 's'}</span>
                <button className="text-xs text-danger ml-auto" data-testid="set-delete" disabled={busy !== null}
                  onClick={() => { if (window.confirm(`Remove the set “${s.name}”? The products in it are not touched.`)) void send('DELETE', null, `d-${s.id}`, `/api/catalogue-sets?id=${encodeURIComponent(s.id)}`); }}>
                  Remove set
                </button>
              </div>

              {open && (
                <div className="mt-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <select value={adding[s.id] ?? ''} onChange={(e) => setAdding((a) => ({ ...a, [s.id]: e.target.value }))}
                      data-testid="set-add-pick" className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink" style={{ minWidth: 220 }}>
                      <option value="">Add a product…</option>
                      {candidates.map((p) => <option key={p.id} value={p.id}>{p.title || p.name || p.code}</option>)}
                    </select>
                    <button data-testid="set-add" disabled={busy !== null || !adding[s.id]}
                      onClick={async () => {
                        const id = adding[s.id];
                        if (!id) return;
                        const next = [...s.members, { id: 'new', catalogueItemId: id, position: s.members.length }];
                        if (await saveMembers(s, next)) setAdding((a) => ({ ...a, [s.id]: '' }));
                      }}
                      className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-3 py-2 disabled:opacity-50">Add</button>
                    <select value={s.shape} data-testid="set-reshape" disabled={busy !== null}
                      onChange={(e) => void send('PATCH', { id: s.id, shape: e.target.value }, `s-${s.id}`)}
                      className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink ml-auto">
                      <option value="pick_one">{SHAPE_LABEL.pick_one}</option>
                      <option value="base_plus_extras">{SHAPE_LABEL.base_plus_extras}</option>
                    </select>
                  </div>

                  {s.members.length === 0
                    ? <p className="text-xs text-muted mt-3" data-testid="set-empty">Nothing in this set yet.</p>
                    : (
                      <ol className="mt-3 space-y-1">
                        {s.members.map((m, i) => (
                          <li key={m.id} className="flex items-center gap-2 text-sm text-ink" data-testid="set-member" data-item={m.catalogueItemId}>
                            {/* The NUMBER only means something in a ladder; a menu shows a bullet,
                                because a numbered menu reads as a ranking nobody chose. */}
                            <span className="text-xs text-muted w-5 tabular-nums">{s.shape === 'pick_one' ? `${i + 1}.` : '·'}</span>
                            <span>{label(m.catalogueItemId)}</span>
                            <span className="ml-auto flex gap-1">
                              <button data-testid="set-member-up" disabled={busy !== null || i === 0} onClick={() => move(s, i, -1)}
                                className="text-xs px-1.5 py-0.5 rounded border border-line text-muted disabled:opacity-30">↑</button>
                              <button data-testid="set-member-down" disabled={busy !== null || i === s.members.length - 1} onClick={() => move(s, i, 1)}
                                className="text-xs px-1.5 py-0.5 rounded border border-line text-muted disabled:opacity-30">↓</button>
                              <button data-testid="set-member-remove" disabled={busy !== null}
                                onClick={() => void saveMembers(s, s.members.filter((x) => x.id !== m.id))}
                                className="text-xs px-1.5 py-0.5 rounded border border-line text-danger">Remove</button>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  <p className="text-xs text-muted mt-2">{SHAPE_HINT[s.shape]}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
