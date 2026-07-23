/**
 * File: pages/admin/products/index.tsx
 * Products (catalogue) — ADMIN/owner only. Simple items (part/labour/misc) stay flat. Fixed-price
 * services morph into: a component list (cost + spec text), a base price (ex VAT), and — if the
 * tenant has tiers — a per-tier price grid with live inc-VAT + margin. All money is EX-VAT with the
 * inc-VAT figure shown live beneath. A "Service tiers" section manages the tenant's optional tiers.
 * i18n-native, formatMoney, mobile-first.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';
import { displayCurrency } from '@/lib/display-currency';
import PromotionsSection from '@/components/products/PromotionsSection';

type ItemType = 'labour' | 'part' | 'misc' | 'fixed';
type Comp = { description: string; qty: number; unitCostExVat: number };
type TierPrice = { tierId: string; priceExVat: number | null };
type Item = {
  id: string; code: string; title: string | null; name: string; itemType: ItemType; unitCost: number | null; unitPrice: number; vatRate: number; active: boolean;
  basePriceExVat: number | null; labourHours: number | null; labourOutsourced?: boolean; components: Comp[]; tierPrices: TierPrice[];
};
type Tier = { id: string; name: string; position: number; active: boolean };

type FormComp = { description: string; qty: string; cost: string };
type TierCell = { price: string; manual: boolean };
type FormState = {
  id: string | null; code: string; title: string; name: string; itemType: ItemType; active: boolean; vatRate: string;
  cost: string; price: string;              // simple
  basePrice: string; labourHours: string; labourOutsourced: boolean; components: FormComp[]; tierCells: Record<string, TierCell>; // fixed
};

const inc = (exPounds: number, rate: number) => exPounds * (1 + (rate || 0) / 100);
// Margin ON PRICE (not markup on cost). Divide-by-zero (price 0) → null → shown as "—", never NaN/∞.
const marginPct = (price: number, cost: number): number | null => (price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null);
const pctLabel = (price: number, cost: number): string => { const m = marginPct(price, cost); return m === null ? '—' : `${m}%`; };
// UNCOSTED = priced item with NO cost recorded (unit_cost null). Labour items never flag (no parts
// cost). A £0 cost is NOT uncosted (legitimately free). Its margin reads as 100% and must NOT show.
const isUncosted = (i: Item): boolean =>
  i.itemType !== 'labour' && i.unitCost == null && (i.unitPrice > 0 || (i.basePriceExVat ?? 0) > 0);
const inputCls = 'mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink';
const labelCls = 'text-sm font-medium text-ink';

export default function ProductsPage({ currency, locale }: { currency: string; locale: string }) {
  const { t } = useTranslation('products');
  const money = (pounds: number) => formatMoney(Math.round((pounds || 0) * 100), { currency, locale });
  const [items, setItems] = useState<Item[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [defaultVatRate, setDefaultVatRate] = useState('20');
  const [vatRegistered, setVatRegistered] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showUncostedOnly, setShowUncostedOnly] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [newTier, setNewTier] = useState('');
  const [editTier, setEditTier] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const activeTiers = useMemo(() => tiers.filter((tt) => tt.active), [tiers]);

  async function load() {
    const res = await fetch('/api/catalogue');
    if (!res.ok) return;
    const data = await res.json();
    setItems(data.items || []);
    setTiers(data.tiers || []);
    setVatRegistered(!!data.vatRegistered);
    if (data.defaultVatRate != null) setDefaultVatRate(String(data.defaultVatRate));
  }
  useEffect(() => { load(); }, []);

  // Small ex/inc renderer.
  const ExInc = ({ ex, rate }: { ex: number; rate: number }) => (
    <span className="text-xs text-muted">{money(ex)} {t('exVat')}{vatRegistered ? ` · ${money(inc(ex, rate))} ${t('incVat')}` : ''}</span>
  );

  // ---- item form ----
  const blankTierCells = (): Record<string, TierCell> => Object.fromEntries(activeTiers.map((tt) => [tt.id, { price: '', manual: false }]));
  // Deep-link: /admin/products?edit=<id> opens that product's editor once items load
  // (the dashboard's missing-hours drill lands here).
  const router = useRouter();
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !router.isReady || !items.length) return;
    const editId = router.query.edit ? String(router.query.edit) : null;
    if (!editId) { deepLinked.current = true; return; }
    const it = items.find((i2) => i2.id === editId);
    if (it) openEdit(it);
    deepLinked.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, items]);

  // Prefill from the estimate builder's "Add to catalogue" shortcut: ?add=part&name=&price=&cost=.
  // Opens the create form pre-populated so an ADMIN only picks a code + VAT. The catalogue is the
  // cost home — cost is authored HERE, never trusted from the estimate line.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !router.isReady) return;
    prefilled.current = true;
    if (router.query.add !== 'part') return;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    setMsg(null);
    setForm({ id: null, code: '', title: '', name: str(router.query.name), itemType: 'part', active: true, vatRate: defaultVatRate, cost: str(router.query.cost), price: str(router.query.price), basePrice: '', labourHours: '', labourOutsourced: false, components: [], tierCells: blankTierCells() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  function openAdd() { setMsg(null); setForm({ id: null, code: '', title: '', name: '', itemType: 'part', active: true, vatRate: defaultVatRate, cost: '', price: '', basePrice: '', labourHours: '', labourOutsourced: false, components: [], tierCells: blankTierCells() }); }
  function openEdit(i: Item) {
    setMsg(null);
    const cells: Record<string, TierCell> = {};
    for (const tt of activeTiers) {
      const row = i.tierPrices.find((tp) => tp.tierId === tt.id);
      cells[tt.id] = row ? (row.priceExVat === null ? { price: '', manual: true } : { price: String(row.priceExVat), manual: false }) : { price: '', manual: false };
    }
    setForm({
      id: i.id, code: i.code, title: i.title ?? '', name: i.name, itemType: i.itemType, active: i.active, vatRate: String(i.vatRate),
      cost: i.unitCost == null ? '' : String(i.unitCost), price: String(i.unitPrice),
      basePrice: i.basePriceExVat == null ? '' : String(i.basePriceExVat),
      labourHours: i.labourHours == null ? '' : String(i.labourHours),
      labourOutsourced: !!i.labourOutsourced,
      components: i.components.map((c) => ({ description: c.description, qty: String(c.qty), cost: String(c.unitCostExVat) })),
      tierCells: cells,
    });
  }
  const close = () => setForm(null);

  const isFixed = form?.itemType === 'fixed';
  const compCost = useMemo(() => (form?.components || []).reduce((s, c) => s + (Number(c.qty) || 0) * (Number(c.cost) || 0), 0), [form?.components]);
  const canSave = !!form && form.code.trim() !== '' && form.name.trim() !== ''
    && (isFixed ? form.basePrice !== '' && Number(form.basePrice) >= 0 : (form.price !== '' && form.cost !== '' && Number(form.cost) >= 0));

  const setComp = (idx: number, patch: Partial<FormComp>) => setForm((f) => f && ({ ...f, components: f.components.map((c, i) => i === idx ? { ...c, ...patch } : c) }));
  const addComp = () => setForm((f) => f && ({ ...f, components: [...f.components, { description: '', qty: '1', cost: '' }] }));
  const rmComp = (idx: number) => setForm((f) => f && ({ ...f, components: f.components.filter((_, i) => i !== idx) }));
  const setCell = (tierId: string, patch: Partial<TierCell>) => setForm((f) => f && ({ ...f, tierCells: { ...f.tierCells, [tierId]: { ...f.tierCells[tierId], ...patch } } }));

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const common = { id: form.id || undefined, code: form.code.trim(), title: form.title.trim(), name: form.name.trim(), itemType: form.itemType, vatRate: Number(form.vatRate || 0), active: form.active };
    let body: any;
    if (isFixed) {
      const tierPrices = activeTiers.flatMap((tt): Array<{ tierId: string; priceExVat: number | null }> => {
        const cell = form.tierCells[tt.id] || { price: '', manual: false };
        if (cell.manual) return [{ tierId: tt.id, priceExVat: null }];
        if (cell.price !== '') return [{ tierId: tt.id, priceExVat: Number(cell.price) }];
        return []; // inherit base
      });
      body = { ...common, basePriceExVat: Number(form.basePrice || 0), labourHours: form.labourHours.trim() === '' ? null : Number(form.labourHours), labourOutsourced: form.labourOutsourced, components: form.components.map((c) => ({ description: c.description.trim(), qty: Number(c.qty || 0), unitCostExVat: Number(c.cost || 0) })), tierPrices };
    } else {
      // BLANK cost → null (NOT ENTERED, flagged uncosted); an explicit 0 → 0 (legitimately free).
      body = { ...common, unitCost: form.cost.trim() === '' ? null : Number(form.cost), unitPrice: Number(form.price) };
    }
    try {
      const res = await fetch('/api/catalogue', { method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); setBusy(false); return; }
      await load(); setForm(null); setMsg({ text: t('saved'), ok: true });
    } catch { setMsg({ text: t('error'), ok: false }); }
    setBusy(false);
  }
  async function setActive(i: Item, active: boolean) { setBusy(true); try { const r = await fetch('/api/catalogue', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id, active }) }); if (r.ok) await load(); } finally { setBusy(false); } }
  async function hardDelete(i: Item) { if (!confirm(t('confirmDelete'))) return; setBusy(true); try { const r = await fetch(`/api/catalogue?id=${encodeURIComponent(i.id)}`, { method: 'DELETE' }); if (r.ok) { await load(); setForm(null); } } finally { setBusy(false); } }

  // ---- tiers CRUD ----
  async function addTier() { if (!newTier.trim()) return; setBusy(true); try { const r = await fetch('/api/service-tiers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newTier.trim() }) }); if (r.ok) { setNewTier(''); await load(); } } finally { setBusy(false); } }
  async function tierActive(tt: Tier, active: boolean) { setBusy(true); try { const r = await fetch('/api/service-tiers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tt.id, active }) }); if (r.ok) await load(); } finally { setBusy(false); } }
  async function tierDelete(tt: Tier) { if (!confirm(t('tiers.confirmDelete'))) return; setBusy(true); try { const r = await fetch(`/api/service-tiers?id=${encodeURIComponent(tt.id)}`, { method: 'DELETE' }); if (r.ok) await load(); } finally { setBusy(false); } }
  // Rename via the existing PATCH — an UPDATE (not delete+add), so the tier keeps its identity and its
  // attached CatalogueItemTierPrice rows survive.
  async function saveTierEdit() {
    if (!editTier || !editTier.name.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/service-tiers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editTier.id, name: editTier.name.trim() }) });
      if (r.ok) { setEditTier(null); await load(); }
    } finally { setBusy(false); }
  }
  // ▲▼ reorder: move a tier one slot, then reindex positions 0..N-1 in the new order (fixes legacy
  // all-zero positions in one pass) and PATCH only the rows whose position changed. The tiers list,
  // fixed-product price grid, and card tier-picker all sort by position, so the order flows to all three.
  async function moveTier(id: string, dir: -1 | 1) {
    const ordered = [...tiers];
    const i = ordered.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    setBusy(true);
    try {
      for (let k = 0; k < ordered.length; k++) {
        if (ordered[k].position !== k) {
          await fetch('/api/service-tiers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ordered[k].id, position: k }) });
        }
      }
      await load();
    } finally { setBusy(false); }
  }

  const typeLabel = (ty: ItemType) => t(ty);
  const uncostedCount = items.filter((i) => i.active && isUncosted(i)).length; // active items only
  const shown = items.filter((i) => (showArchived || i.active) && (!showUncostedOnly || isUncosted(i)));
  const rate = form ? Number(form.vatRate || 0) : Number(defaultVatRate);

  return (
    <>
      <Head><title>Products - GreaseDesk</title></Head>
      <div className="max-w-3xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-3xl font-bold text-ink">{t('title')}</h1>
            <p className="text-sm text-muted mt-1 max-w-xl">{t('intro')}</p>
          </div>
          {!form && <button onClick={openAdd} className="shrink-0 bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm">{t('add')}</button>}
        </div>

        {/* Service tiers */}
        <details className="bg-surface border border-line rounded-xl p-4 mb-5">
          <summary className="cursor-pointer font-semibold text-ink">{t('tiers.heading')} <span className="text-muted font-normal text-sm">({tiers.length})</span></summary>
          <p className="text-xs text-muted mt-2">{t('tiers.intro')}</p>
          <ul className="mt-3 space-y-1">
            {tiers.map((tt, idx) => (
              <li key={tt.id} className={`flex flex-wrap items-center gap-2 text-sm ${tt.active ? '' : 'opacity-60'}`}>
                {editTier?.id === tt.id ? (
                  <>
                    <input value={editTier.name} onChange={(e) => setEditTier({ ...editTier, name: e.target.value })} placeholder={t('tiers.name')} className="flex-1 min-w-[8rem] bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink" autoFocus />
                    <button onClick={saveTierEdit} disabled={busy || !editTier.name.trim()} className="text-xs bg-accent hover:bg-accent-hover text-white rounded px-2 py-1 disabled:opacity-50">{t('tiers.save')}</button>
                    <button onClick={() => setEditTier(null)} disabled={busy} className="text-xs text-muted hover:text-ink">{t('tiers.cancel')}</button>
                  </>
                ) : (
                  <>
                    <span className="flex flex-col leading-none mr-1">
                      <button onClick={() => moveTier(tt.id, -1)} disabled={busy || idx === 0} aria-label={t('tiers.moveUp')} className="text-muted hover:text-ink disabled:opacity-30 text-xs leading-none">▲</button>
                      <button onClick={() => moveTier(tt.id, 1)} disabled={busy || idx === tiers.length - 1} aria-label={t('tiers.moveDown')} className="text-muted hover:text-ink disabled:opacity-30 text-xs leading-none">▼</button>
                    </span>
                    <span className="text-ink flex-1">{tt.name}{!tt.active && <span className="ml-2 text-[10px] uppercase text-muted">{t('tiers.archived')}</span>}</span>
                    <button onClick={() => setEditTier({ id: tt.id, name: tt.name })} disabled={busy} className="text-xs text-accent hover:underline">{t('tiers.edit')}</button>
                    {tt.active
                      ? <button onClick={() => tierActive(tt, false)} disabled={busy} className="text-xs text-muted hover:text-ink">{t('tiers.archive')}</button>
                      : <button onClick={() => tierActive(tt, true)} disabled={busy} className="text-xs text-accent hover:underline">{t('tiers.restore')}</button>}
                    <button onClick={() => tierDelete(tt)} disabled={busy} className="text-xs text-danger hover:underline">{t('tiers.delete')}</button>
                  </>
                )}
              </li>
            ))}
            {tiers.length === 0 && <li className="text-sm text-muted">{t('tiers.empty')}</li>}
          </ul>
          <div className="mt-3 flex gap-2">
            <input value={newTier} onChange={(e) => setNewTier(e.target.value)} placeholder={t('tiers.name')} className="flex-1 bg-surface border border-line rounded-lg px-3 py-1.5 text-sm text-ink" />
            <button onClick={addTier} disabled={busy || !newTier.trim()} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-1.5 disabled:opacity-50">{t('tiers.add')}</button>
          </div>
        </details>

        {/* Promotions (discount codes) — managed here, applied garage-side on the estimate. */}
        <PromotionsSection
          products={items.filter((i) => i.active).map((i) => ({ id: i.id, code: i.code, title: i.title, name: i.name }))}
          defaultVatRate={Number(defaultVatRate || 0)} vatRegistered={vatRegistered}
          currency={currency} locale={locale}
        />

        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        {form && (
          <div className="bg-surface border border-line rounded-xl p-4 sm:p-6 mb-5">
            <h2 className="font-semibold text-ink mb-3">{form.id ? t('edit') : t('add')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className={labelCls}>{t('code')}</span>
                <input value={form.code} placeholder={t('codePlaceholder')} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>{t('type')}</span>
                <select value={form.itemType} onChange={(e) => setForm({ ...form, itemType: e.target.value as ItemType })} className={inputCls}>
                  <option value="part">{t('part')}</option><option value="labour">{t('labour')}</option><option value="fixed">{t('fixed')}</option><option value="misc">{t('misc')}</option>
                </select></label>
              <label className="block sm:col-span-2"><span className={labelCls}>{t('titleLabel')}</span>
                <input value={form.title} placeholder={t('titlePlaceholder')} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} /></label>
              <label className="block sm:col-span-2"><span className={labelCls}>{t('name')}</span>
                <textarea value={form.name} placeholder={t('namePlaceholder')} rows={2} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inputCls} resize-y`} /></label>

              {!isFixed && (<>
                <label className="block"><span className={labelCls}>{t('cost')} {t('exVat')}</span>
                  <input type="number" inputMode="decimal" step="0.01" min={0} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className={inputCls} />
                  <ExInc ex={Number(form.cost || 0)} rate={rate} /></label>
                <label className="block"><span className={labelCls}>{t('price')} {t('exVat')}</span>
                  <input type="number" inputMode="decimal" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={inputCls} />
                  <ExInc ex={Number(form.price || 0)} rate={rate} /></label>
              </>)}

              <label className="block"><span className={labelCls}>{t('vatRate')}</span>
                <input type="number" inputMode="decimal" step="0.01" min={0} max={100} value={form.vatRate} onChange={(e) => setForm({ ...form, vatRate: e.target.value })} className={inputCls} /></label>
              <label className="flex items-center gap-2 pt-6"><input type="checkbox" className="w-5 h-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span className={labelCls}>{t('active')}</span></label>
            </div>

            {isFixed && (
              <div className="mt-4 space-y-4">
                {/* Components */}
                <div className="border-t border-line pt-3">
                  <div className="flex items-center justify-between"><span className={labelCls}>{t('components')}</span><span className="text-xs text-muted">{t('componentsTotal')}: {money(compCost)} {t('exVat')}</span></div>
                  <p className="text-xs text-muted">{t('componentsHint')}</p>
                  <div className="mt-2 space-y-2">
                    {form.components.map((c, i) => (
                      <div key={i} className="grid grid-cols-12 gap-2 items-center">
                        <textarea value={c.description} rows={2} onChange={(e) => setComp(i, { description: e.target.value })} placeholder={t('componentDesc')} className="col-span-12 sm:col-span-6 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink resize-y" />
                        <input type="number" inputMode="decimal" step="0.01" min={0} value={c.qty} onChange={(e) => setComp(i, { qty: e.target.value })} aria-label={t('componentQty')} className="col-span-3 sm:col-span-2 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink text-right" />
                        <input type="number" inputMode="decimal" step="0.01" min={0} value={c.cost} onChange={(e) => setComp(i, { cost: e.target.value })} aria-label={t('componentCost')} className="col-span-6 sm:col-span-3 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink text-right" placeholder={t('componentCost')} />
                        <button onClick={() => rmComp(i)} className="col-span-3 sm:col-span-1 text-xs text-danger hover:underline">{t('remove')}</button>
                      </div>
                    ))}
                  </div>
                  <button onClick={addComp} className="mt-2 text-sm text-accent hover:underline">+ {t('addComponent')}</button>
                </div>

                {/* Base price */}
                <div className="border-t border-line pt-3">
                  <label className="block sm:w-64"><span className={labelCls}>{t('basePrice')} {t('exVat')}</span>
                    <input type="number" inputMode="decimal" step="0.01" min={0} value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: e.target.value })} className={inputCls} />
                    <ExInc ex={Number(form.basePrice || 0)} rate={rate} /></label>
                  <p className="text-xs text-muted mt-1">{t('margin')}: <span className="text-ink font-medium">{money(Number(form.basePrice || 0) - compCost)}</span> {t('exVat')} · <span className="text-ink font-medium">{pctLabel(Number(form.basePrice || 0), compCost)}</span></p>
                  <label className="block sm:w-64 mt-3"><span className={labelCls}>{t('labourHours')}</span>
                    <input type="number" inputMode="decimal" step="0.25" min={0} value={form.labourHours} onChange={(e) => setForm({ ...form, labourHours: e.target.value })} className={inputCls} />
                    <span className="text-xs text-muted mt-0.5 block">{form.labourOutsourced ? t('labourHoursHintOutsourced') : t('labourHoursHint')}</span></label>
                  {/* Outsourced / bought-in: cost of sale, invisible to utilisation. The word the
                      owner must see without reading docs — prominent, with a plain-English hint. */}
                  <label className="flex items-start gap-2 mt-3 text-sm text-ink">
                    <input type="checkbox" checked={form.labourOutsourced} onChange={(e) => setForm({ ...form, labourOutsourced: e.target.checked })} className="mt-0.5" />
                    <span className="font-medium">{t('outsourced')}<span className="block text-xs text-muted font-normal">{t('outsourcedHint')}</span></span>
                  </label>
                </div>

                {/* Tier grid */}
                {activeTiers.length > 0 && (
                  <div className="border-t border-line pt-3">
                    <span className={labelCls}>{t('tierGrid.heading')}</span>
                    <p className="text-xs text-muted">{t('tierGrid.hint')}</p>
                    <div className="mt-2 space-y-2">
                      {activeTiers.map((tt) => {
                        const cell = form.tierCells[tt.id] || { price: '', manual: false };
                        const eff = cell.manual ? null : (cell.price !== '' ? Number(cell.price) : Number(form.basePrice || 0));
                        return (
                          <div key={tt.id} className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-ink w-28 shrink-0">{tt.name}</span>
                            <input type="number" inputMode="decimal" step="0.01" min={0} disabled={cell.manual}
                              value={cell.price} placeholder={t('tierGrid.inherit')}
                              onChange={(e) => setCell(tt.id, { price: e.target.value })}
                              className="w-28 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink text-right disabled:opacity-50" />
                            <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={cell.manual} onChange={(e) => setCell(tt.id, { manual: e.target.checked })} />{t('tierGrid.manual')}</label>
                            <span className="text-xs text-muted">
                              {cell.manual ? t('tierGrid.perJob') : <>{money(eff ?? 0)} {t('exVat')}{vatRegistered ? ` · ${money(inc(eff ?? 0, rate))} ${t('incVat')}` : ''} · {t('margin')} {money((eff ?? 0) - compCost)} · {pctLabel(eff ?? 0, compCost)}</>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 flex items-center gap-2">
              <button onClick={save} disabled={busy || !canSave} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? t('saving') : t('save')}</button>
              <button onClick={close} className="text-muted hover:text-ink rounded-lg px-4 py-2 text-sm">{t('cancel')}</button>
              {form.id && <button onClick={() => hardDelete(items.find((x) => x.id === form.id)!)} disabled={busy} className="ml-auto text-danger hover:bg-danger-soft rounded-lg px-3 py-2 text-sm">{t('delete')}</button>}
            </div>
          </div>
        )}

        {uncostedCount > 0 && (
          <button type="button" onClick={() => setShowUncostedOnly((v) => !v)}
            className={`w-full text-left rounded-xl border px-4 py-3 mb-3 text-sm ${showUncostedOnly ? 'bg-warn-soft border-warn text-warn' : 'bg-warn-soft/60 border-warn/50 text-warn hover:brightness-95'}`}>
            <span className="font-semibold">⚠ {t('uncosted.banner', { count: uncostedCount })}</span>
            <span className="ml-1 underline">{showUncostedOnly ? t('uncosted.showAll') : t('uncosted.showThese')}</span>
          </button>
        )}
        <label className="flex items-center gap-2 text-sm text-muted mb-3"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('showArchived')}</label>

        {shown.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {shown.map((i) => {
              const isFx = i.itemType === 'fixed';
              const base = i.basePriceExVat ?? 0;
              const price = isFx ? base : i.unitPrice;
              const uncosted = isUncosted(i);
              const cost = i.unitCost; // number | null (fixed: mirror of Σ components; null = none recorded)
              return (
                <li key={i.id} className={`flex flex-wrap items-center gap-3 p-3 bg-surface ${i.active ? '' : 'opacity-60'} ${uncosted ? 'ring-1 ring-inset ring-warn/40' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink font-medium truncate">
                      <span className="font-mono text-xs bg-surface-muted border border-line rounded px-1.5 py-0.5 mr-2">{i.code}</span>{i.name}
                      {uncosted && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-warn-soft text-warn">{t('uncosted.badge')}</span>}
                      {i.labourOutsourced && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-accent-soft text-accent">{t('outsourcedBadge')}</span>}
                      {!i.active && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">{t('archived')}</span>}
                    </div>
                    <div className="text-xs text-muted mt-0.5">
                      {typeLabel(i.itemType)} · {isFx ? t('basePrice') : t('price')} {money(price)} {t('exVat')}
                      {uncosted
                        ? <> · <span className="text-warn font-medium">{t('uncosted.noCost')}</span></>
                        : <> · {t('cost')} {money(cost ?? 0)} · {t('margin')} {money(price - (cost ?? 0))} · {pctLabel(price, cost ?? 0)}</>}
                      {isFx && ` · ${i.components.length} ${t('componentsShort')}${i.tierPrices.length ? ` · ${i.tierPrices.length} ${t('tierPricesShort')}` : ''}`}
                    </div>
                  </div>
                  <button onClick={() => openEdit(i)} className="text-sm text-accent hover:underline">{t('edit')}</button>
                  {i.active
                    ? <button onClick={() => setActive(i, false)} disabled={busy} className="text-sm text-muted hover:text-ink">{t('archive')}</button>
                    : <button onClick={() => setActive(i, true)} disabled={busy} className="text-sm text-accent hover:underline">{t('restore')}</button>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['products', 'promos'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: { ...(await displayCurrency(gate.vis.primarySiteId)) } };
});
