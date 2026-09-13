/**
 * File: pages/admin/stock.tsx
 * THE YARD. Every car currently in stock, oldest first, with the number that matters on each.
 *
 * ── A LIST IS THE DEFAULT VIEW, NOT A DETAIL PAGE ───────────────────────────────────────────────
 * Built for a garage doing a hundred a year, not one a month. At one a month a stock record can hang
 * off a vehicle page and be found by remembering the car; at a hundred, the question is never "what
 * about that Golf" — it is "what have I got, and what has been here too long". So the list is the
 * page, and a car is a row in it.
 *
 * DAYS IN STOCK IS ON EVERY ROW because it is the figure a garage counts on its fingers today, and
 * the one that turns into money: it drives the cost of money and the advertising slot, and the oldest
 * car is the one paying for both. Oldest first for the same reason — the answer goes where it is seen.
 */
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { SOURCES, SOURCE_RULES, VAT_STATUSES, availableVatStatuses, type PurchaseSource, type VatStatus } from '@/lib/purchase-model';
// LEAF import — lib/stock reaches no database, so this cannot ship Prisma to the browser.
import { LABOUR_AT_ZERO_NOTE } from '@/lib/stock';

type Row = {
  stockItemId: string; vehicleId: string; registration: string; description: string | null;
  acquiredAt: string; daysInStock: number; purchasePence: number; vatStatus: string; source: string;
  prepPence: number; prepUnknownLines: number; prepCards: number;
};

const money = (p: number) => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function StockPage({ vatRegistered }: { vatRegistered: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    registration: '', make: '', model: '', acquiredAt: today(),
    purchase: '', premium: '', services: '',
    source: 'auction' as PurchaseSource, vatStatus: 'margin' as VatStatus,
    // The auction invoice's own fields. Blank is a real answer for every one of them.
    vin: '', firstRegistered: '', motExpiry: '', v5cReference: '',
    isImport: 'unknown', mileage: '', mileageWarranted: 'unknown',
  });
  /**
   * DID DVSA ANSWER FOR THIS PLATE? Not "did we ask" — a lookup that fails teaches nothing, and a
   * form that locked its MOT field on a failed lookup would be unfillable for exactly the imports
   * this screen exists to record. Null until asked, false when asked and told nothing.
   */
  const [dvsaMot, setDvsaMot] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/stock');
    setRows(res.ok ? (await res.json()).stock : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ONLY WHAT THIS SOURCE CAN PRODUCE — the same rule as the purchase model, from the same reader, so
  // a private purchase cannot be recorded as VAT qualifying here either.
  const allowedVat = useMemo(() => availableVatStatuses(form.source), [form.source]);

  /**
   * PRE-POPULATE FROM DVSA, and say so. Runs when the plate is finished with, not on every keystroke.
   *
   * What comes back is a verified fact and the field goes READ-ONLY: the server refuses a typed date
   * that contradicts a checked one, so an editable box here would only invite a refusal at the end of
   * a form. Where DVSA has nothing — an import, a car too new to have been tested — the field stays
   * open and whatever is typed is stored as stated, never as verified.
   */
  async function lookupPlate(reg: string) {
    const plate = reg.trim();
    if (plate.length < 2) return;
    setLooking(true);
    try {
      const res = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(plate)}`);
      const body = await res.json().catch(() => ({}));
      if (body?.found) {
        setDvsaMot(body.motExpiry ?? null);
        setForm((f) => ({
          ...f,
          make: f.make || body.make || '',
          model: f.model || body.model || '',
          // TYPED WINS over looked-up for first registration: unlike the MOT date this is not a fact
          // DVSA is authoritative about — it is the date on the logbook, and the person holding the
          // logbook is looking at it. Fill the blank, never overwrite an answer.
          firstRegistered: f.firstRegistered || body.firstRegistered || '',
          motExpiry: body.motExpiry ?? f.motExpiry,
        }));
      } else setDvsaMot(null);
    } catch {
      setDvsaMot(null);   // a failed lookup leaves the field OPEN; it does not claim DVSA said nothing
    } finally {
      setLooking(false);
    }
  }

  async function add() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration: form.registration, make: form.make, model: form.model,
          acquiredAt: form.acquiredAt,
          purchasePence: Math.round(Number(form.purchase || 0) * 100),
          premiumPence: Math.round(Number(form.premium || 0) * 100),
          servicesPence: Math.round(Number(form.services || 0) * 100),
          source: form.source, vatStatus: form.vatStatus,
          vin: form.vin, firstRegistered: form.firstRegistered, motExpiry: form.motExpiry,
          v5cReference: form.v5cReference, isImport: form.isImport,
          mileageMiles: form.mileage === '' ? null : Number(form.mileage),
          mileageWarranted: form.mileageWarranted,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg(`${form.registration.toUpperCase()} is in stock.`);
        setForm({
          ...form, registration: '', make: '', model: '', purchase: '', premium: '', services: '',
          vin: '', firstRegistered: '', motExpiry: '', v5cReference: '',
          isImport: 'unknown', mileage: '', mileageWarranted: 'unknown',
        });
        setDvsaMot(null);
        setAdding(false);
        await load();
      } else {
        setMsg(body.message ?? 'Could not add that.');
      }
    } catch {
      setMsg('Could not add that.');
    } finally {
      setBusy(false);   // cleared in finally, per the standing rule — a same-URL refresh never remounts
    }
  }

  const total = rows?.reduce((a, r) => a + r.purchasePence, 0) ?? 0;

  // NO <AdminLayout> HERE. pages/_app.tsx wraps every /admin route already, and rendering it again
  // nests the shell inside itself — admin-shell-gate catches exactly this, and caught it here.
  return (
    <>
      <Head><title>Stock — GreaseDesk</title></Head>
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold text-ink">Stock</h1>
          <button type="button" onClick={() => setAdding((v) => !v)} data-testid="add-toggle"
            className="min-h-[44px] rounded-lg bg-accent px-4 text-sm font-medium text-white">
            {adding ? 'Cancel' : 'Buy a car'}
          </button>
        </div>
        {rows && rows.length > 0 && (
          <p className="mt-1 text-sm text-muted" data-testid="stock-summary">
            {rows.length} {rows.length === 1 ? 'car' : 'cars'} in stock, {money(total)} tied up.
          </p>
        )}
        {/* THE NOTE, ONCE, UNDER THE FIGURE IT QUALIFIES — not on every row, where it would become
            furniture and stop being read. Labour absent is a STATED omission, not a zero. */}
        {rows && rows.some((r) => r.prepCards > 0) && (
          <p className="mt-1 text-xs text-muted" data-testid="prep-note">
            Prep is parts at trade cost from cards marked as work on our own stock. {LABOUR_AT_ZERO_NOTE}
            {rows.some((r) => r.prepUnknownLines > 0)
              && ' A ° marks a car with parts whose trade cost nobody recorded — that car’s figure is a floor, not a total.'}
          </p>
        )}
        {msg && <p className="mt-2 text-sm text-ink" data-testid="stock-msg">{msg}</p>}

        {adding && (
          <section className="mt-4 rounded-xl border border-line bg-surface p-3 sm:p-4" data-testid="add-form">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <label className="text-sm text-muted">Registration
                <input value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value })}
                  onBlur={(e) => void lookupPlate(e.target.value)}
                  data-testid="input-reg" autoCapitalize="characters"
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg uppercase" />
              </label>
              <label className="text-sm text-muted">Make
                <input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })}
                  data-testid="input-make"
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
              </label>
              <label className="text-sm text-muted">Model
                <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}
                  data-testid="input-model"
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
              </label>
              <label className="text-sm text-muted">VIN
                <input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value.toUpperCase() })}
                  data-testid="input-vin" autoCapitalize="characters" maxLength={20} spellCheck={false}
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink uppercase" />
              </label>
              <label className="text-sm text-muted">First registered
                <input type="date" value={form.firstRegistered} max={today()}
                  onChange={(e) => setForm({ ...form, firstRegistered: e.target.value })}
                  data-testid="input-first-registered" className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
              </label>
              {/*
                MOT EXPIRY, AND WHERE IT CAME FROM. Read-only once DVSA has answered — the record is
                theirs, and the server refuses a typed date that contradicts a checked one, so an open
                box would collect a value only to reject it. Open when DVSA has nothing, which is the
                import and the not-yet-tested car: those are typed, stored, and never marked verified.
              */}
              <label className="text-sm text-muted">MOT expires
                <input type="date" value={form.motExpiry} readOnly={dvsaMot !== null}
                  onChange={(e) => setForm({ ...form, motExpiry: e.target.value })}
                  data-testid="input-mot-expiry"
                  className={`mt-1 w-full min-h-[44px] p-2 border border-line rounded-lg text-ink ${dvsaMot !== null ? 'bg-canvas' : 'bg-surface'}`} />
                <span className="block mt-1 text-xs text-muted" data-testid="mot-provenance">
                  {looking ? 'Checking DVSA…'
                    : dvsaMot !== null ? 'From DVSA — verified, so it cannot be edited here.'
                    : 'DVSA has no MOT for this plate. Anything you type is recorded as stated, not verified.'}
                </span>
              </label>
              <label className="text-sm text-muted">Mileage
                <input type="number" inputMode="numeric" min={0} value={form.mileage}
                  onChange={(e) => setForm({ ...form, mileage: e.target.value })}
                  data-testid="input-mileage" className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
              </label>
              <label className="text-sm text-muted">Mileage warranted
                <select value={form.mileageWarranted} data-testid="input-warranted"
                  onChange={(e) => setForm({ ...form, mileageWarranted: e.target.value })} className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink">
                  <option value="unknown">Not stated</option>
                  <option value="yes">Warranted</option>
                  <option value="no">Not warranted</option>
                </select>
              </label>
              <label className="text-sm text-muted">V5C reference
                <input value={form.v5cReference} onChange={(e) => setForm({ ...form, v5cReference: e.target.value })}
                  data-testid="input-v5c" autoComplete="off" spellCheck={false} className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
                <span className="block mt-1 text-xs text-muted">Held, never shown again or written to a trail.</span>
              </label>
              <label className="text-sm text-muted">Import
                <select value={form.isImport} data-testid="input-import"
                  onChange={(e) => setForm({ ...form, isImport: e.target.value })} className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink">
                  <option value="unknown">Not recorded</option>
                  <option value="no">UK supplied</option>
                  <option value="yes">Imported</option>
                </select>
              </label>
              <label className="text-sm text-muted">Bought on
                <input type="date" value={form.acquiredAt} max={today()}
                  onChange={(e) => setForm({ ...form, acquiredAt: e.target.value })}
                  data-testid="input-acquired"
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
              </label>
              <label className="text-sm text-muted">Price paid
                <input type="number" inputMode="decimal" min={0} value={form.purchase}
                  onChange={(e) => setForm({ ...form, purchase: e.target.value })} data-testid="input-purchase"
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
              </label>
              <label className="text-sm text-muted">Where from
                <select value={form.source} data-testid="input-source"
                  onChange={(e) => {
                    const source = e.target.value as PurchaseSource;
                    const allowed = availableVatStatuses(source);
                    // THE ANSWER CARRIES ITS CONSEQUENCES, exactly as on the purchase model: a source
                    // that cannot be qualifying moves the treatment back rather than leaving an
                    // impossible pair on screen for a render.
                    setForm((f) => ({ ...f, source, vatStatus: allowed.includes(f.vatStatus) ? f.vatStatus : allowed[0] }));
                  }}
                  className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink">
                  {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_RULES[s].label}</option>)}
                </select>
              </label>
            </div>

            {/* THE FEES, ONLY WHERE THE INVOICE CARRIES THEM — the same rule and the same reader as
                the purchase model, so the two pages cannot disagree about what an auction invoice has. */}
            {SOURCE_RULES[form.source].fees.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-3" data-testid="fee-fields">
                {SOURCE_RULES[form.source].fees.map((f) => (
                  <label key={f.slot} className="text-sm text-muted">{f.label}
                    <input type="number" inputMode="decimal" min={0} step="0.01"
                      value={f.slot === 'premium' ? form.premium : form.services}
                      onChange={(e) => setForm({ ...form, [f.slot === 'premium' ? 'premium' : 'services']: e.target.value })}
                      data-testid={`input-fee-${f.slot}`}
                      className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
                  </label>
                ))}
              </div>
            )}

            <fieldset className="mt-3" data-testid="vat-status">
              <legend className="text-sm text-muted">VAT treatment</legend>
              <div className="mt-1 flex gap-2">
                {VAT_STATUSES.filter((v) => allowedVat.includes(v)).map((v) => (
                  <button key={v} type="button" onClick={() => setForm({ ...form, vatStatus: v })}
                    data-testid={`vat-${v}`}
                    className={`flex-1 min-h-[44px] rounded-lg border text-sm font-medium ${
                      form.vatStatus === v ? 'bg-accent text-white border-accent' : 'bg-surface text-ink border-line'}`}>
                    {v === 'margin' ? 'Margin scheme' : 'VAT qualifying'}
                  </button>
                ))}
              </div>
              {/* CAPTURED AT PURCHASE AND NEVER RE-READ — said on the form, because it is the one
                  answer here that cannot be corrected later by changing a setting. */}
              <p className="mt-1 text-xs text-muted" data-testid="vat-captured-note">
                Recorded against this car as bought. It stays whatever you say here, whatever your own VAT status does later.
              </p>
              {allowedVat.length === 1 && (
                <p className="mt-1 text-xs text-muted" data-testid="vat-forced">
                  {SOURCE_RULES[form.source].label} means there is no VAT invoice to reclaim against, so the margin scheme is the only route.
                </p>
              )}
            </fieldset>

            <button type="button" onClick={add} disabled={busy || !form.registration.trim()}
              data-testid="add-submit"
              className="mt-4 min-h-[44px] w-full sm:w-auto rounded-lg bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">
              Take into stock
            </button>
          </section>
        )}

        {/* ── THE YARD ─────────────────────────────────────────────────────────────────────────── */}
        {rows === null ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="mt-6 text-sm text-muted" data-testid="stock-empty">
            Nothing in stock. “Buy a car” records one — the record is what says you own it.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" data-testid="stock-list">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted border-b border-line">
                  <th className="text-left py-1">Car</th>
                  <th className="text-left py-1">Bought</th>
                  <th className="text-right py-1">Days in stock</th>
                  <th className="text-right py-1">Paid</th>
                  <th className="text-right py-1">Prep</th>
                  <th className="text-right py-1">In it</th>
                  <th className="text-left py-1 pl-3">VAT</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.stockItemId} className="border-b border-line/50" data-testid={`stock-row-${r.registration}`}>
                    <td className="py-2">
                      <span className="font-medium text-ink">{r.registration}</span>
                      {r.description && <span className="ml-2 text-muted">{r.description}</span>}
                    </td>
                    <td className="py-2 text-muted tabular-nums">{r.acquiredAt.slice(0, 10)}</td>
                    {/* THE NUMBER THAT TURNS INTO MONEY. Emphasised past 90 days rather than coloured
                        by a threshold nobody chose — 90 is three advertising slot-months and a quarter
                        of a year's interest, which is where a garage starts to feel it. */}
                    <td className={`py-2 text-right tabular-nums ${r.daysInStock >= 90 ? 'text-danger font-semibold' : 'text-ink'}`}
                      data-testid={`days-${r.registration}`}>
                      {r.daysInStock}
                    </td>
                    <td className="py-2 text-right text-ink tabular-nums">{money(r.purchasePence)}</td>
                    {/* PARTS AT TRADE COST from prep cards linked to this car. Labour is absent because
                        there is no measured workshop rate — the note under the table says so rather
                        than a zero implying nobody worked on it. A ° marks a car with parts whose cost
                        nobody recorded: the figure is then a floor, not a total. */}
                    <td className="py-2 text-right text-muted tabular-nums" data-testid={`prep-${r.registration}`}>
                      {r.prepCards ? money(r.prepPence) : '—'}
                      {r.prepUnknownLines > 0 && <span className="text-danger" title="Some parts have no trade cost recorded">°</span>}
                    </td>
                    {/* WHAT THE CAR OWES YOU SO FAR. The number a person actually wants when they look
                        at a yard: what has to come back before this one has made anything. */}
                    <td className="py-2 text-right text-ink font-medium tabular-nums" data-testid={`inv-${r.registration}`}>
                      {money(r.purchasePence + r.prepPence)}
                    </td>
                    <td className="py-2 pl-3 text-muted">{r.vatStatus === 'margin' ? 'Margin' : 'Qualifying'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!vatRegistered && rows && rows.length > 0 && (
          <p className="mt-3 text-xs text-muted" data-testid="not-registered">
            You are not VAT registered, so the margin scheme does not apply to your sales — the treatment is recorded for when it does.
          </p>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { getTaxProfile } = await import('@/lib/tenant-vat');
  const profile = await getTaxProfile(gate.vis.groupId as string).catch(() => null);
  return { props: { vatRegistered: profile?.isRegistered === true } };
});
