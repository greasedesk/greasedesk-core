/**
 * File: pages/admin/stock/[id].tsx
 * ONE CAR IN STOCK — what it cost, what has gone into it, and what it will make.
 *
 * NO <AdminLayout> here: pages/_app.tsx already wraps every /admin route, and admin-shell-gate
 * catches a page that renders the shell inside itself.
 *
 * WHAT IS NOT EDITABLE, and why it is refused by the WRITER and not merely missing from this form:
 * a field absent from a form is one a later form can put back. lib/stock-store::updateStockItem
 * refuses the VAT treatment, the source, and everything on a disposed car. This page only has to
 * explain the refusal; it does not enforce it.
 */
import SellCarPanel from '@/components/stock/SellCarPanel';
import type { OpenPrepCard } from '@/lib/stock-sale-rules';
import Head from 'next/head';
import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { SOURCE_RULES, type PurchaseSource } from '@/lib/purchase-model';
import { LABOUR_AT_ZERO_NOTE } from '@/lib/stock';
import { MISSING_COST_KINDS } from '@/lib/stock-projection';
import { STOCK_COST_KINDS, STOCK_COST_LABELS, VAT_TREATMENT_LABELS, costKindLabel, type StockCostKind } from '@/lib/stock-cost';
import { paperworkField, paperworkText, type PaperworkKey } from '@/lib/stock-paperwork';
import { FROZEN_DETAIL_NOTE, PREP_EXPAND_THRESHOLD } from '@/lib/stock-prep';
import { VAT_TREATMENTS } from '@/lib/purchase-model';

const money = (p: number) => `£${(p / 100).toFixed(2)}`;
const iso = (d: string) => d.slice(0, 10);

/**
 * ONE PLACE THESE WORDS COME FROM. The form and the breakdown both ask SOURCE_RULES, so a figure
 * cannot be called "Indemnities" in one and something else in the other. Falls back to the slot's own
 * name rather than to a generic word — an unknown source should read oddly, not read as "Fees".
 */
const feeLabel = (source: string, slot: 'premium' | 'services'): string =>
  SOURCE_RULES[source as PurchaseSource]?.fees.find((f) => f.slot === slot)?.label ?? slot;
const VAT_LABEL: Record<string, string> = VAT_TREATMENT_LABELS;


type Detail = {
  stockItemId: string; vehicleId: string; registration: string; description: string | null;
  acquiredAt: string; daysInStock: number; purchasePence: number; premiumPence: number;
  servicesPence: number; vatStatus: string; source: string; mileageWarranted: boolean | null;
  projectedSalePence: number | null;
  prep: { partsPence: number; unknownCostLines: number; labourLines: number; cards: number };
  prepDetail: null | { mode: 'live'; groups: Array<{
      cardId: string; createdAt: string; subtotalPence: number; labourLines: number; unknownCostLines: number;
      lines: Array<{ description: string; itemType: string; qty: number; unitCostPence: number | null;
        linePence: number | null; excludedBecause: string | null }>;
    }> } | { mode: 'frozen'; rows: Array<{ kind: string; description: string; amountPence: number; jobCardId: string | null }> };
  costRows: { id: string; kind: string; description: string; amountPence: number; incurredOn: string; vatTreatment: string; reversesId: string | null }[];
  costs: { netPence: number; reclaimablePence: number; costPence: number; grossOutPence: number; creditedPence: number; rows: number };
  projection: null | {
    salePence: number; grossProfitPence: number; totalCostsPence: number; vatDuePence: number;
    partsPence: number; missingCostKinds: string[]; note: string;
  };
  disposedAt: string | null; disposalKind: string | null; salePence: number | null;
  book: {
    stockNumber: number | null; sellerName: string | null; purchaseRef: string | null; notOnPaperwork: string[];
    vin: string | null; colour: string | null;
    sale: null | { recordedNotInvoiced: boolean; receiptRef: string | null; invoiceNumber: string | null;
      buyerName: string | null; buyerAddress: string | null; notOnPaperwork: string[]; saleMileage: number | null };
  };
};

export default function StockCarPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ acquiredAt: '', purchase: '', premium: '', services: '', warranted: 'unknown', projected: '' });
  const [cost, setCost] = useState({ kind: 'delivery_in' as StockCostKind, description: '', amount: '', incurredOn: '', vatTreatment: 'standard_not_recoverable' });
  const [credit, setCredit] = useState<{ id: string; amount: string; on: string } | null>(null);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const [openPrep, setOpenPrep] = useState<OpenPrepCard[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/stock?id=${encodeURIComponent(id)}`);
    if (!res.ok) { setMsg('That car is not on this account.'); return; }
    const body = await res.json();
    const det: Detail = body.detail;
    setD(det);
    setOpenPrep(Array.isArray(body.openPrepCards) ? body.openPrepCards : []);
    setForm({
      acquiredAt: iso(det.acquiredAt),
      purchase: (det.purchasePence / 100).toFixed(2),
      premium: (det.premiumPence / 100).toFixed(2),
      services: (det.servicesPence / 100).toFixed(2),
      warranted: det.mileageWarranted === null ? 'unknown' : det.mileageWarranted ? 'yes' : 'no',
      projected: det.projectedSalePence === null ? '' : (det.projectedSalePence / 100).toFixed(2),
    });
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', stockItemId: id, acquiredAt: form.acquiredAt,
          purchasePence: Math.round(Number(form.purchase || 0) * 100),
          premiumPence: Math.round(Number(form.premium || 0) * 100),
          servicesPence: Math.round(Number(form.services || 0) * 100),
          mileageWarranted: form.warranted,
          // BLANK CLEARS IT, back to "nobody has said" — see updateStockItem.
          projectedSalePence: form.projected === '' ? 0 : Math.round(Number(form.projected) * 100),
        }),
      });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? 'Saved.' : (body.message ?? 'Could not save that.'));
      if (res.ok) await load();
    } catch {
      setMsg('Could not save that.');
    } finally {
      setBusy(false);   // cleared in finally, per the standing rule
    }
  }

  /** One poster for both cost writes — same clamp, same reload, same finally. */
  async function post(body: Record<string, unknown>, onOk?: () => void) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stockItemId: id }),
      });
      const b = await res.json().catch(() => ({}));
      setMsg(res.ok ? 'Saved.' : (b.message ?? 'Could not save that.'));
      if (res.ok) { onOk?.(); await load(); }
    } catch {
      setMsg('Could not save that.');
    } finally {
      setBusy(false);   // cleared in finally, per the standing rule
    }
  }

  const saveCost = () => post({
    action: 'add-cost', kind: cost.kind, description: cost.description,
    amountPence: Math.round(Number(cost.amount || 0) * 100),
    incurredOn: cost.incurredOn, vatTreatment: cost.vatTreatment,
  }, () => setCost({ ...cost, description: '', amount: '' }));

  const saveCredit = () => credit && post({
    action: 'credit-cost', reversesId: credit.id,
    amountPence: Math.round(Number(credit.amount || 0) * 100),
    incurredOn: credit.on,
  }, () => setCredit(null));

  /** The live line groups, or none when the car has gone (then the frozen rows render instead). */
  const liveGroups = d?.prepDetail?.mode === 'live' ? d.prepDetail.groups : [];
  const input = 'mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink';
  const sold = !!d?.disposedAt;

  return (
    <>
      <Head><title>{d ? `${d.registration} · Stock` : 'Stock'}</title></Head>
      <div className="p-4 sm:p-6 max-w-3xl">
        <Link href="/admin/stock" className="text-sm text-muted underline" data-testid="back-to-yard">← The yard</Link>
        {!d ? <p className="mt-4 text-muted" data-testid="detail-loading">{msg ?? 'Loading…'}</p> : (
          <>
            <h1 className="mt-2 text-2xl font-bold text-ink" data-testid="detail-reg">{d.registration}</h1>
            <p className="text-muted">{d.description ?? '—'} · {SOURCE_RULES[d.source as PurchaseSource]?.label ?? d.source}</p>

            {sold && (
              <div className="mt-3 rounded-xl border border-line bg-surface p-3 text-sm text-ink" data-testid="detail-sold">
                Sold {iso(d.disposedAt as string)}{d.salePence !== null ? ` for ${money(d.salePence)}` : ''}. Its figures were
                frozen at disposal and nothing here can change now — re-running a past quarter has to give what it gave then.
              </div>
            )}

            {/* ── WHAT IT WILL MAKE ──────────────────────────────────────────────────────────── */}
            <section className="mt-5 rounded-xl border border-line bg-surface p-4" data-testid="projection">
              <h2 className="text-sm font-semibold text-ink">Gross profit on this car</h2>
              {d.projection ? (
                <>
                  <p className="text-3xl font-bold text-ink tabular-nums mt-1" data-testid="projected-profit">
                    {money(d.projection.grossProfitPence)}
                  </p>
                  <p className="text-sm text-muted">
                    If it sells for {money(d.projection.salePence)}. Before your fixed monthly costs and tax.
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted">Paid for the car</dt><dd className="text-right text-ink tabular-nums">{money(d.purchasePence)}</dd>
                    {/* THE SAME NAMES AS THE FIELDS ABOVE, from the same rules. A breakdown that calls
                        a figure something the form does not is two names for one number. */}
                    {d.premiumPence > 0 && (<><dt className="text-muted">{feeLabel(d.source, 'premium')}</dt><dd className="text-right text-ink tabular-nums">{money(d.premiumPence)}</dd></>)}
                    {d.servicesPence > 0 && (<><dt className="text-muted">{feeLabel(d.source, 'services')}</dt><dd className="text-right text-ink tabular-nums">{money(d.servicesPence)}</dd></>)}
                    <dt className="text-muted">Parts fitted (trade cost)</dt><dd className="text-right text-ink tabular-nums" data-testid="detail-prep">{money(d.prep.partsPence)}</dd>
                    <dt className="text-muted">VAT due on the sale</dt><dd className="text-right text-ink tabular-nums">{money(d.projection.vatDuePence)}</dd>
                  </dl>
                  {/* THE NUMBER MUST SAY WHAT IS NOT IN IT. Optimistic in a way the reader cannot see
                      is worse than absent — see lib/stock-projection. */}
                  <p className="mt-3 text-xs text-muted" data-testid="projection-note">{d.projection.note}</p>
                </>
              ) : (
                <p className="text-sm text-muted mt-1" data-testid="projection-absent">
                  {sold
                    ? 'This car is sold — the price it actually fetched is the answer, not what we expected.'
                    : 'Say what you expect to sell it for and this will work out what it makes. Nothing is assumed: with no figure there is no projection, because a £0 sale would read as a loss.'}
                </p>
              )}
            </section>

            {/* ── SELL IT ──────────────────────────────────────────────────────────────────────
                Below the profit, deliberately: the price is decided with the cost in view. Gone once
                the car has left — a sold car's figures are frozen. */}
            {!sold && (
              <SellCarPanel stockItemId={id} registration={d.registration} description={d.description} vatStatus={d.vatStatus}
                projectedSalePence={d.projectedSalePence} openPrepCards={openPrep} />
            )}

            {/* ── THE STOCK BOOK'S ROW FOR THIS CAR ───────────────────────────────────────────────
                Three states per field, from lib/stock-paperwork: a value; "not supplied" (somebody looked
                and it was not on the paperwork); "not recorded" (nobody was asked). A row with anything
                not recorded SAYS it is incomplete rather than looking finished. */}
            {(() => {
              const bk = d.book;
              const f = (v: string | null, k: PaperworkKey, ticks: string[]) => paperworkField(v, k, ticks);
              const rows: Array<[string, string, string, boolean]> = [
                ['Stock number', bk.stockNumber !== null ? String(bk.stockNumber) : 'not recorded', 'sb-stock-number', bk.stockNumber === null],
                ...([['VIN', f(bk.vin, 'vin', bk.notOnPaperwork), 'sb-vin'],
                  ['Colour', f(bk.colour, 'colour', bk.notOnPaperwork), 'sb-colour'],
                  ['Seller', f(bk.sellerName, 'seller_name', bk.notOnPaperwork), 'sb-seller'],
                  ['Purchase invoice or receipt', f(bk.purchaseRef, 'purchase_ref', bk.notOnPaperwork), 'sb-purchase-ref']] as const)
                  .map(([label, fld, id]) => [label, paperworkText(fld), id, fld.state === 'not_recorded'] as [string, string, string, boolean]),
              ];
              if (bk.sale) {
                const buyer = f(bk.sale.buyerName, 'buyer_name', bk.sale.notOnPaperwork);
                const addr = f(bk.sale.buyerAddress, 'buyer_address', bk.sale.notOnPaperwork);
                rows.push(['Buyer', paperworkText(buyer), 'sb-buyer', buyer.state === 'not_recorded']);
                rows.push(["Buyer's address", paperworkText(addr), 'sb-buyer-address', addr.state === 'not_recorded']);
                const sm = f(bk.sale.saleMileage !== null ? bk.sale.saleMileage.toLocaleString('en-GB') : null, 'sale_mileage', bk.sale.notOnPaperwork);
                rows.push(['Mileage at sale', paperworkText(sm), 'sb-sale-mileage', sm.state === 'not_recorded']);
                if (bk.sale.recordedNotInvoiced) {
                  const rc = f(bk.sale.receiptRef, 'receipt_ref', bk.sale.notOnPaperwork);
                  rows.push(['Sale', `Recorded, not invoiced — receipt ${paperworkText(rc)}`, 'sb-sale-document', rc.state === 'not_recorded']);
                } else {
                  rows.push(['Sale', bk.sale.invoiceNumber ? `Invoice ${bk.sale.invoiceNumber}` : 'not recorded', 'sb-sale-document', !bk.sale.invoiceNumber]);
                }
              }
              const missing = rows.filter((r) => r[3]).map((r) => r[0]);
              return (
                <section className="mt-4 rounded-xl border border-line bg-surface p-4" data-testid="stock-book">
                  <h2 className="text-sm font-semibold text-ink">Stock book</h2>
                  {missing.length > 0 && (
                    <p className="mt-1 text-sm text-warn" data-testid="stock-book-incomplete">
                      Incomplete: {missing.join(', ')} {missing.length === 1 ? 'was' : 'were'} never recorded for this car.
                    </p>
                  )}
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {rows.map(([label, value, id]) => (
                      <React.Fragment key={id}>
                        <dt className="text-muted">{label}</dt>
                        <dd className="text-ink whitespace-pre-line" data-testid={id}>{value}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </section>
              );
            })()}

            {/* ── WHAT HAS GONE INTO IT ──────────────────────────────────────────────────────── */}
            <section className="mt-4 rounded-xl border border-line bg-surface p-4" data-testid="prep-section">
              <h2 className="text-sm font-semibold text-ink">Work on this car</h2>
              <p className="text-sm text-ink mt-1">
                {d.prep.cards === 0 ? 'No prep cards linked to this car yet.'
                  : `${money(d.prep.partsPence)} of parts across ${d.prep.cards} card${d.prep.cards === 1 ? '' : 's'}.`}
                {d.prep.unknownCostLines > 0 && (
                  <span className="text-danger" data-testid="prep-unknown"> {d.prep.unknownCostLines} line(s) have no trade cost recorded, so the figure is a floor, not a total.</span>
                )}
              </p>

              {/* ── THE LINES THEMSELVES ─────────────────────────────────────────────────────────
                  Grouped by CARD, because a card is the unit of work and thirty lines across five
                  cards read as five things. Collapsed past a threshold so the page stays readable as
                  a car accumulates work over months. */}
              {d.prepDetail?.mode === 'live' && d.prepDetail.groups.length > 0 && (
                <div className="mt-3 space-y-2" data-testid="prep-lines">
                  {liveGroups.map((grp, gi) => {
                    /* BELOW THE THRESHOLD everything is open: collapsing two cards is chrome for no
                       gain. At or above it they arrive summarised and the reader opens what they want. */
                    const open = openCards[grp.cardId] ?? (liveGroups.length < PREP_EXPAND_THRESHOLD);
                    return (
                      <div key={grp.cardId} className="rounded-lg border border-line" data-testid={`prep-card-${gi}`}>
                        <button type="button" className="w-full flex items-center justify-between gap-2 p-2 text-left"
                          data-testid={`prep-card-toggle-${gi}`}
                          onClick={() => setOpenCards((o) => ({ ...o, [grp.cardId]: !open }))}>
                          <span className="text-sm text-ink">
                            <span aria-hidden className="text-muted mr-1">{open ? '▾' : '▸'}</span>
                            {iso(grp.createdAt)}
                            {/* A REFERENCE NOBODY CAN FOLLOW IS DECORATION. It lands on the workshop
                                screen, which is where the work was. */}
                            <a href={`/admin/jobcards/${grp.cardId}`} onClick={(e) => e.stopPropagation()}
                              className="ml-2 font-mono text-xs underline text-accent"
                              data-testid={`prep-card-link-${gi}`}>card {grp.cardId.slice(0, 8)}</a>
                          </span>
                          <span className="text-sm text-ink tabular-nums shrink-0">{money(grp.subtotalPence)}</span>
                        </button>
                        {open && (
                          <table className="w-full text-sm border-t border-line">
                            <tbody>
                              {grp.lines.map((l, i) => (
                                <tr key={i} className="border-b border-line/40 last:border-0" data-testid={`prep-line-${gi}-${i}`}>
                                  <td className="py-1.5 px-2">
                                    <span className={l.excludedBecause ? 'text-muted' : 'text-ink'}>{l.description}</span>
                                    <span className="ml-2 text-xs text-muted">×{l.qty}</span>
                                    {/* THE REASON IN PLACE — which line is holding the figure down,
                                        not merely that some line is. */}
                                    {l.excludedBecause && (
                                      <span className="block text-[11px] text-muted" data-testid={`prep-line-why-${gi}-${i}`}>
                                        {l.excludedBecause}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                                    {l.linePence === null
                                      ? <span className="text-muted">—</span>
                                      : l.linePence === 0
                                        ? <span className="text-muted">not costed</span>
                                        : <span className="text-ink">{money(l.linePence)}</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* A SOLD CAR SHOWS CARD-LEVEL TOTALS ONLY, and says why — the freeze rule holding. */}
              {d.prepDetail?.mode === 'frozen' && (
                <div className="mt-3" data-testid="prep-frozen">
                  <table className="w-full text-sm">
                    <tbody>
                      {d.prepDetail.rows.map((r, i) => (
                        <tr key={i} className="border-b border-line/40 last:border-0">
                          <td className="py-1.5"><span className="text-ink">{r.description}</span>
                            {r.jobCardId && (
                              <a href={`/admin/jobcards/${r.jobCardId}`} className="ml-2 font-mono text-xs underline text-accent">
                                card {r.jobCardId.slice(0, 8)}
                              </a>
                            )}
                          </td>
                          <td className="py-1.5 text-right text-ink tabular-nums">{money(r.amountPence)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-muted" data-testid="frozen-note">{FROZEN_DETAIL_NOTE}</p>
                </div>
              )}

              <p className="mt-1 text-xs text-muted" data-testid="labour-note">{LABOUR_AT_ZERO_NOTE}</p>
              <p className="mt-1 text-xs text-muted" data-testid="missing-costs">
                Not yet recordable against a car at all: {MISSING_COST_KINDS.join(', ').toLowerCase()}.
              </p>
            </section>

            {/* ── WHAT CAN BE CORRECTED ──────────────────────────────────────────────────────── */}
                    {/* ── WHAT ELSE IT HAS COST ───────────────────────────────────────────────────── */}
            <section className="mt-4 rounded-xl border border-line bg-surface p-4" data-testid="costs-section">
              <h2 className="text-sm font-semibold text-ink">Costs besides parts</h2>
              {d.costRows.length === 0 ? (
                <p className="text-sm text-muted mt-1" data-testid="costs-empty">Nothing recorded yet.</p>
              ) : (
                <table className="w-full text-sm mt-2" data-testid="costs-table">
                  <tbody>
                    {/*
                      CREDITS NEST UNDER THE COST THEY REVERSE, never as siblings. A reader scanning a
                      column of amounts sees £250 and −£250 as two unrelated events; indented under
                      their parent they read as one thing that happened and came back.

                      A FULLY CREDITED COST STAYS VISIBLE while the car is in stock, struck through.
                      In stock the reader is asking why the total is lower than the spend, and an
                      invisible row cannot answer that. It vanishes from the FROZEN snapshot at
                      disposal, where a £0 line would only invite "why is this here".
                    */}
                    {d.costRows.filter((c) => !c.reversesId).map((c) => {
                      const credits = d.costRows.filter((x) => x.reversesId === c.id);
                      const back = credits.reduce((a, x) => a + x.amountPence, 0);
                      const fully = back >= c.amountPence && c.amountPence > 0;
                      return (
                      <>
                      <tr key={c.id} className="border-b border-line/50" data-testid={`cost-row-${c.id}`}>
                        <td className="py-1.5 text-muted tabular-nums w-24">{iso(c.incurredOn)}</td>
                        <td className="py-1.5">
                          <span className={fully ? 'text-muted line-through' : 'text-ink'}>{c.description}</span>
                          <span className="ml-2 text-xs text-muted">{costKindLabel(c.kind)}</span>
                          {fully && <span className="ml-2 text-xs text-muted" data-testid={`fully-credited-${c.id}`}>credited in full</span>}
                        </td>
                        <td className={`py-1.5 text-right tabular-nums ${fully ? 'text-muted line-through' : 'text-ink'}`}>
                          {money(c.amountPence)}
                        </td>
                        <td className="py-1.5 pl-2 text-right w-20">
                          {!sold && !fully && (
                            <button type="button" className="text-xs underline text-muted"
                              data-testid={`credit-${c.id}`}
                              onClick={() => setCredit({ id: c.id, amount: '', on: new Date().toISOString().slice(0, 10) })}>
                              Credit
                            </button>
                          )}
                        </td>
                      </tr>
                      {/* INDENTED, AND ATTACHED. A credit is not a negative number: it is a row that
                          says what it reverses, and it reads that way here. */}
                      {credits.map((x) => (
                        <tr key={x.id} className="border-b border-line/50" data-testid={`credit-row-${x.id}`}>
                          <td className="py-1.5 text-muted tabular-nums w-24 pl-4">{iso(x.incurredOn)}</td>
                          <td className="py-1.5 pl-4">
                            <span className="text-accent text-xs font-semibold mr-1">↳ credited back</span>
                            <span className="text-muted text-xs">{x.description}</span>
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-accent">−{money(x.amountPence)}</td>
                          <td className="py-1.5 pl-2 w-20" />
                        </tr>
                      ))}
                      </>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {d.costs.rows > 0 && (
                <p className="mt-2 text-sm text-ink" data-testid="costs-total">
                  {money(d.costs.netPence)} net of credits
                  {d.costs.reclaimablePence > 0 && <> · {money(d.costs.reclaimablePence)} of that is VAT you can reclaim, so the car bears {money(d.costs.costPence)}</>}.
                </p>
              )}

              {credit && (
                <div className="mt-3 rounded-lg border border-line p-3" data-testid="credit-form">
                  <p className="text-sm text-ink font-medium">Credit against this cost</p>
                  <p className="text-xs text-muted">
                    The original stays. A supplier taking a failed part back does not mean the car never had one —
                    what is true is that the money went out and came back. You cannot credit more than was paid.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 items-end">
                    <label className="text-sm text-muted">Amount back
                      <input type="number" step="0.01" min={0} value={credit.amount} data-testid="credit-amount"
                        onChange={(e) => setCredit({ ...credit, amount: e.target.value })} className={input} />
                    </label>
                    <label className="text-sm text-muted">On
                      <input type="date" value={credit.on} data-testid="credit-date"
                        onChange={(e) => setCredit({ ...credit, on: e.target.value })} className={input} />
                    </label>
                    <button onClick={() => void saveCredit()} disabled={busy} data-testid="credit-save"
                      className="min-h-[44px] px-4 rounded-lg bg-accent text-white font-semibold disabled:opacity-60">Record it</button>
                    <button onClick={() => setCredit(null)} className="min-h-[44px] px-3 text-sm text-muted underline">Cancel</button>
                  </div>
                </div>
              )}

              {!sold && !credit && (
                <div className="mt-3 grid grid-cols-2 gap-3" data-testid="add-cost-form">
                  <label className="text-sm text-muted">Kind
                    <select value={cost.kind} data-testid="cost-kind" className={input}
                      onChange={(e) => setCost({ ...cost, kind: e.target.value as StockCostKind })}>
                      {STOCK_COST_KINDS.map((k) => <option key={k} value={k}>{STOCK_COST_LABELS[k]}</option>)}
                    </select>
                  </label>
                  <label className="text-sm text-muted">What was it for
                    <input value={cost.description} data-testid="cost-description" className={input}
                      onChange={(e) => setCost({ ...cost, description: e.target.value })} />
                  </label>
                  <label className="text-sm text-muted">Amount paid
                    <input type="number" step="0.01" min={0} value={cost.amount} data-testid="cost-amount" className={input}
                      onChange={(e) => setCost({ ...cost, amount: e.target.value })} />
                  </label>
                  <label className="text-sm text-muted">On
                    <input type="date" value={cost.incurredOn} data-testid="cost-date" className={input}
                      onChange={(e) => setCost({ ...cost, incurredOn: e.target.value })} />
                  </label>
                  <label className="text-sm text-muted col-span-2">VAT on the supplier's invoice
                    <select value={cost.vatTreatment} data-testid="cost-vat" className={input}
                      onChange={(e) => setCost({ ...cost, vatTreatment: e.target.value })}>
                      {VAT_TREATMENTS.map((v) => <option key={v} value={v}>{VAT_LABEL[v]}</option>)}
                    </select>
                  </label>
                  <div className="col-span-2">
                    <button onClick={() => void saveCost()} disabled={busy} data-testid="cost-save"
                      className="min-h-[44px] px-4 rounded-lg bg-accent text-white font-semibold disabled:opacity-60">Add this cost</button>
                  </div>
                </div>
              )}
            </section>

    <section className="mt-4 rounded-xl border border-line bg-surface p-4" data-testid="edit-section">
              <h2 className="text-sm font-semibold text-ink">Correct the record</h2>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="text-sm text-muted">Bought on
                  <input type="date" value={form.acquiredAt} disabled={sold} data-testid="edit-acquired"
                    onChange={(e) => setForm({ ...form, acquiredAt: e.target.value })} className={input} />
                </label>
                <label className="text-sm text-muted">Price paid
                  <input type="number" step="0.01" min={0} value={form.purchase} disabled={sold} data-testid="edit-purchase"
                    onChange={(e) => setForm({ ...form, purchase: e.target.value })} className={input} />
                </label>
                {/*
                  ── THE LABELS COME FROM SOURCE_RULES, NOT FROM THIS FILE ──────────────────────
                  This page said "Buyer's premium" and "Fees". The second is not a thing that appears
                  on any invoice, and it told the owner nothing — so £250 of recovery went into it,
                  which is a cost besides parts and not an acquisition service at all.

                  lib/purchase-model already names these per SOURCE, and differently: an auction's
                  second slot is INDEMNITIES (Simulcast, SureCheck), a dealer's is an ADMIN OR
                  DELIVERY FEE. A page that types its own generic word cannot be right for both, and
                  was right for neither. The intake form reads these rules; this one now does too.

                  A source with no fee slots (private, part-exchange, return, buyback) renders none —
                  an empty box labelled "Fees" is an invitation to put something in it.
                */}
                {(SOURCE_RULES[d.source as PurchaseSource]?.fees ?? []).map((f) => (
                  <label key={f.slot} className="text-sm text-muted sm:col-span-2">{f.label}
                    <input type="number" step="0.01" min={0} disabled={sold}
                      value={f.slot === 'premium' ? form.premium : form.services}
                      data-testid={`edit-${f.slot}`}
                      onChange={(e) => setForm(f.slot === 'premium'
                        ? { ...form, premium: e.target.value }
                        : { ...form, services: e.target.value })}
                      className={input} />
                    {/* THE INVOICE'S OWN WORDS, from the same rule as the label — so the note cannot
                        drift from the field it explains. */}
                    <span className="block mt-1 text-xs text-muted">{f.note}</span>
                  </label>
                ))}
                <label className="text-sm text-muted">Mileage warranted
                  <select value={form.warranted} disabled={sold} data-testid="edit-warranted"
                    onChange={(e) => setForm({ ...form, warranted: e.target.value })} className={input}>
                    <option value="unknown">Not stated</option>
                    <option value="yes">Warranted</option>
                    <option value="no">Not warranted</option>
                  </select>
                </label>
                <label className="text-sm text-muted">Expected sale price
                  <input type="number" step="0.01" min={0} value={form.projected} disabled={sold} data-testid="edit-projected"
                    placeholder="Not estimated"
                    onChange={(e) => setForm({ ...form, projected: e.target.value })} className={input} />
                </label>
              </div>

              {/*
                WHERE THE OTHER MONEY GOES, said HERE rather than left to be worked out. The two
                fields above are what the SELLER charged on the purchase invoice. A recovery man's
                invoice, a valet, an MOT — different supplier, different VAT treatment, its own date —
                is a cost besides parts and belongs in the section above, where each row carries its
                own recoverability. Putting it here would fold it into the acquisition and lose that.
              */}
              <p className="mt-2 text-xs text-muted" data-testid="fees-vs-costs">
                Those are what the seller charged you on the purchase invoice. Delivery by someone
                else, valeting, an MOT — anything on a separate invoice — goes in <strong>Costs besides
                parts</strong> above, where each has its own date and its own VAT treatment.
              </p>

              {/* THE FROZEN PAIR, SHOWN AND EXPLAINED. Hiding them would leave a person hunting for a
                  control that is deliberately absent; saying why is the whole point. */}
              <div className="mt-3 rounded-lg border border-line p-3 text-sm" data-testid="frozen-fields">
                <p className="text-ink font-medium">
                  VAT treatment: {d.vatStatus === 'margin' ? 'Margin scheme' : 'VAT qualifying'} · Bought from: {SOURCE_RULES[d.source as PurchaseSource]?.label ?? d.source}
                </p>
                <p className="text-xs text-muted mt-1">
                  Both are fixed from when you bought the car. Reclaiming input VAT forecloses the margin scheme for it
                  and the choice may already be in a filed return, so changing it is your accountant’s call and not a
                  correction. Where it came from decides which treatments are even allowed, so it is fixed with it.
                </p>
              </div>

              {!sold && (
                <button onClick={() => void save()} disabled={busy} data-testid="edit-save"
                  className="mt-3 min-h-[44px] px-4 rounded-lg bg-accent text-white font-semibold disabled:opacity-60">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              )}
              {msg && <p className="mt-2 text-sm text-ink" data-testid="edit-msg">{msg}</p>}
            </section>
          </>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
});
