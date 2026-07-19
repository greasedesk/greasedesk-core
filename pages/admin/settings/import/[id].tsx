/**
 * File: pages/admin/settings/import/[id].tsx
 * The five-step import wizard for ONE staged invoice.
 * Parsed invoice on the left, the job card being built on the right, blanks highlighted.
 *
 *   1 Customer & vehicle — match reported EXPLICITLY before commit; attach, never duplicate
 *   2 Lines             — pre-filled from line memory; adjustments cost 0.00 and never prompt
 *   3 Diary             — date defaults to the invoice date and is EDITABLE; nothing auto-shifts
 *   4 Completion        — attestation (an audited stage skip, not a bypassed gate)
 *   5 Invoice & payment — mint via the normal series, carrying the Xero number as external_ref
 */
import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { startTimeSlots } from '@/lib/booking-slots';
import { childAmountPennies, numOrNull } from '@/lib/import-split';

const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STEPS = ['Customer & vehicle', 'Lines', 'Diary', 'Completion', 'Invoice & payment'];

export default function ImportWizard({ isAdmin, isManager }: { isAdmin: boolean; isManager: boolean }) {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [d, setD] = useState<any>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const [attest, setAttest] = useState(false);
  const [pickFor, setPickFor] = useState<string | null>(null); // line id whose picker is open
  const [q, setQ] = useState('');
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const liftPreselected = useRef(false);
  const [draft, setDraft] = useState<any[]>([]);

  async function load() {
    const r = await fetch(`/api/import/staged?id=${id}`);
    const j = await r.json();
    setD(j);
    setStep(j?.staged?.wizard_step ?? 1);
  }
  useEffect(() => { if (id) load(); /* eslint-disable-next-line */ }, [id]);

  // LIFT PRESELECTION. Marking taken lifts but selecting none made the commonest case — one free
  // lift — a decision the operator had to repeat for every invoice. The server suggests the first
  // free lift for the planned footprint; we APPLY it once, visibly, and it stays overridable.
  // Once per mount: a deliberate later clear must not be silently undone on the next load.
  useEffect(() => {
    const st = d?.staged;
    if (!st || st.status === 'committed' || liftPreselected.current) return;
    if (st.planned_resource_id || !d.suggestedLiftId) return;
    liftPreselected.current = true;
    save({ plannedResourceId: d.suggestedLiftId });
    /* eslint-disable-next-line */
  }, [d?.suggestedLiftId, d?.staged?.planned_resource_id, d?.staged?.status]);

  /**
   * THE one way this page reads a response. A 500 from an API route does not carry a JSON body —
   * it is the string "Internal Server Error", so `await r.json()` THROWS and, with no catch, the
   * operator saw nothing at all: the split silently never saved. Every failure now produces a
   * message, and a failure can never borrow success wording.
   */
  async function send(url: string, init: RequestInit): Promise<{ ok: boolean; body: any; text: string }> {
    const r = await fetch(url, init);
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON — see failText below */ }
    return { ok: r.ok, body, text: text.slice(0, 200) };
  }
  /** Never 'Done.' on an error branch: a failure must read as a failure even with no server message. */
  const failText = (res: { body: any; text: string }) =>
    res.body?.message ?? (res.text ? `Failed: ${res.text}` : 'Failed — the server gave no reason.');

  async function save(patch: any) {
    setBusy(true); setMsg(null);
    try {
      const res = await send('/api/import/staged', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) setMsg({ text: failText(res), tone: 'err' });
      else await load();
    } catch (e: any) {
      setMsg({ text: `Save failed: ${e?.message ?? 'the request did not complete'}.`, tone: 'err' });
    } finally { setBusy(false); }
  }

  // Selecting a catalogue item inherits its cost/hours AND applies retroactively to every pending
  // occurrence of the same description + price across all 42 staged invoices.
  async function selectItem(lineId: string, catalogueItemId: string | null) {
    setBusy(true); setMsg(null);
    try {
      const res = await send('/api/import/select-item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catalogueItemId ? { lineId, catalogueItemId } : { lineId, clear: true }),
      });
      setMsg(res.ok
        ? { text: res.body?.message ?? 'Product attached.', tone: 'ok' }
        : { text: failText(res), tone: 'err' });
      setPickFor(null); setQ('');
      if (res.ok) await load();
    } catch (e: any) {
      setMsg({ text: `Could not attach the product: ${e?.message ?? 'the request did not complete'}.`, tone: 'err' });
    } finally { setBusy(false); }
  }

  // A split RE-EXPRESSES a printed line and may never change it: the server refuses anything whose
  // children do not sum to the parent's printed amount to the penny.
  async function saveSplit(lineId: string, children: any[] | null) {
    setBusy(true); setMsg(null);
    try {
      const res = await send('/api/import/split', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(children ? { lineId, children } : { lineId, clear: true }),
      });
      setMsg(res.ok
        ? { text: res.body?.message ?? 'Split saved.', tone: 'ok' }
        : { text: failText(res), tone: 'err' });
      // Only close the editor on success — a refused split must keep what was typed, or the work
      // is lost along with the explanation of why it was refused.
      if (res.ok) { setSplitFor(null); setDraft([]); await load(); }
    } catch (e: any) {
      setMsg({ text: `Split not saved: ${e?.message ?? 'the request did not complete'}.`, tone: 'err' });
    } finally { setBusy(false); }
  }

  async function commit() {
    setBusy(true); setMsg(null);
    try {
      const res = await send('/api/import/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, attest: true }),
      });
      setMsg(res.ok
        ? { text: res.body?.message ?? 'Committed.', tone: 'ok' }
        : { text: failText(res), tone: 'err' });
      if (res.ok) await load();
    } catch (e: any) {
      // The one call that mints: never leave its outcome unstated.
      setMsg({ text: `Commit did not complete: ${e?.message ?? 'no response'}. Reload before retrying.`, tone: 'err' });
    } finally { setBusy(false); }
  }

  if (!d?.staged) {
    return (
      <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
        <Head><title>Import - GreaseDesk</title></Head>
        <p className="text-sm text-muted">Loading…</p>
      </SettingsLayout>
    );
  }

  const s = d.staged;
  const committed = s.status === 'committed';
  const skipped = s.status === 'skipped';
  const issue = new Date(s.issue_date);
  const planned = s.planned_start_at ? new Date(s.planned_start_at) : null;
  const plannedWeekend = planned && (planned.getUTCDay() === 0 || planned.getUTCDay() === 6);
  const vatVar = s.vat_printed != null && s.vat_computed != null &&
    Math.abs(Number(s.vat_printed) - Number(s.vat_computed)) >= 0.005;
  const memOf = (lineId: string) => d.memory?.find((m: any) => m.lineId === lineId)?.hit ?? null;
  // Split children are a re-expression of their parent; the parent is costed THROUGH them.
  const parentIds = new Set(s.lines.filter((l: any) => l.parent_line_id).map((l: any) => l.parent_line_id));
  const childrenOf = (id: string) => s.lines.filter((l: any) => l.parent_line_id === id);
  const topLines = s.lines.filter((l: any) => !l.parent_line_id);
  // Reasons come from lib/import-blockers via the API, so step 2, step 5 and the commit refusal
  // can never disagree. The ONE reason the server cannot know is an unsaved split: children exist
  // only in this browser until Save, so the residual can read "balanced" while nothing is stored.
  const serverBlockers: Array<{ lineId: string; description: string; reason: string }> = d.blockers ?? [];
  const blockers = splitFor
    ? [
        ...serverBlockers.filter((b) => b.lineId !== splitFor),
        {
          lineId: splitFor,
          description: (s.lines.find((l: any) => l.id === splitFor)?.description) ?? 'line',
          reason: 'split not saved — the lines you have typed do not exist yet; press Save split',
        },
      ]
    : serverBlockers;
  const uncosted = blockers;

  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
      <Head><title>Import {s.external_number} - GreaseDesk</title></Head>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">{s.external_number}</h1>
          <p className="text-sm text-muted">
            {issue.toISOString().slice(0, 10)} · {WD[issue.getUTCDay()]} · {s.registration ?? 'no reg'}
          </p>
        </div>
        <Link href="/admin/settings/import" className="text-sm text-muted hover:text-ink">← All invoices</Link>
      </div>

      {/* Hard gates, stated up front */}
      {!s.reconciled && (
        <Banner tone="danger">
          Does not reconcile: lines total £{Number(s.subtotal_parsed).toFixed(2)} but the invoice
          prints £{Number(s.subtotal_printed).toFixed(2)}. This invoice cannot be committed.
        </Banner>
      )}
      {vatVar && (
        <Banner tone="warn">
          VAT variance: printed £{Number(s.vat_printed).toFixed(2)} vs computed £{Number(s.vat_computed).toFixed(2)}.
          VAT is computed through the tax chokepoint, never taken from the PDF — worth checking whether
          a discount was entered VAT-inclusive.
        </Banner>
      )}
      {committed && <Banner tone="ok">Committed. Job card and invoice exist in the ledger; staging is frozen.</Banner>}
      {skipped && (
        <Banner tone="warn">
          Skipped — deliberately not imported: {s.skip_reason || 'no reason recorded'}. It counts as a
          decision, so it no longer holds the period open. Reopen it to change that.
        </Banner>
      )}
      {msg && <Banner tone={msg.tone === 'ok' ? 'ok' : 'danger'}>{msg.text}</Banner>}

      {/* Step rail */}
      <div className="flex flex-wrap gap-1 mb-4">
        {STEPS.map((label, i) => (
          <button key={label} onClick={() => { setStep(i + 1); save({ wizardStep: i + 1 }); }}
            className={`text-xs px-3 py-1.5 rounded-full border ${step === i + 1 ? 'bg-accent text-white border-accent' : 'bg-surface text-muted border-line'}`}>
            {i + 1}. {label}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* ── LEFT: the parsed invoice, verbatim ─────────────────────────────────────────────── */}
        <div className="bg-surface border border-line rounded-xl p-4">
          <h2 className="text-sm font-semibold text-ink mb-3">Parsed invoice</h2>
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr><th className="text-left pb-2">Description</th><th className="text-right pb-2">Qty</th><th className="text-right pb-2">Unit</th><th className="text-right pb-2">Amount</th></tr>
            </thead>
            <tbody>
              {s.lines.map((l: any) => (
                <tr key={l.id} className="border-t border-line align-top">
                  <td className="py-2 pr-2 text-ink">
                    {l.description}
                    {l.continuation_text && (
                      <div className="text-muted mt-1 whitespace-pre-line">{l.continuation_text}</div>
                    )}
                    {l.is_adjustment && <span className="ml-1 text-warn">(adjustment)</span>}
                  </td>
                  <td className="py-2 text-right text-muted">{Number(l.qty)}</td>
                  <td className="py-2 text-right text-muted">{Number(l.unit_price).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}</td>
                  <td className="py-2 text-right text-ink">{Number(l.amount).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line">
                <td colSpan={3} className="pt-2 text-right text-muted">Subtotal (printed)</td>
                <td className="pt-2 text-right font-semibold text-ink">{Number(s.subtotal_printed).toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── RIGHT: the card being built ────────────────────────────────────────────────────── */}
        <div className="bg-surface border border-line rounded-xl p-4">
          <h2 className="text-sm font-semibold text-ink mb-3">{STEPS[step - 1]}</h2>

          {step === 1 && (() => {
            const vehicleKnown = !!d.match?.vehicle;
            const ownerKnown = !!d.match?.customer;
            const parsed = (s.customer_name ?? '').trim();
            const singleToken = parsed !== '' && parsed.split(/\s+/).length < 2;
            // A single token is a COMPLETE record, not an error: where Xero printed only a first
            // name there is no surname to recover, and 16 of the 42 May invoices are like that.
            // It never blocks commit and is never styled as a problem — only a genuinely EMPTY
            // name needs attention, and then only when we are creating the customer.
            const missing = !ownerKnown && parsed === '';
            return (
              <div className="space-y-3 text-sm">
                <Row label="Vehicle"
                  value={vehicleKnown ? `${d.match.vehicle.registration} — EXISTING, will attach` : `${s.registration ?? '—'} — NOT FOUND, will be created`}
                  tone={vehicleKnown ? 'ok' : 'warn'} />
                <Row label="Customer"
                  value={ownerKnown ? `${d.match.customer.name} — EXISTING (from the ownership edge), will attach` : 'NOT FOUND — will be created from the name below'}
                  tone={ownerKnown ? 'ok' : 'warn'} />

                <div>
                  <label className="block text-xs text-muted mb-1">
                    {ownerKnown ? 'Name printed on the invoice (cross-check only)' : 'Customer name'}
                  </label>
                  <input className={inputCls} defaultValue={parsed} disabled={committed || ownerKnown}
                    onBlur={(e) => save({ customerName: e.target.value })} />
                  {ownerKnown ? (
                    <p className="text-xs text-muted mt-1">
                      The owner comes from the vehicle&apos;s ownership edge; this printed name is shown so you can
                      spot a mismatch. Editing it here would not change the customer, so it is read-only.
                    </p>
                  ) : missing ? (
                    <p className="text-xs text-warn mt-1">
                      No name was printed on this invoice. Add one, or commit and name the customer later.
                    </p>
                  ) : singleToken ? (
                    <p className="text-xs text-muted mt-1">
                      The invoice printed a first name only. That is the whole record as billed — edit it if
                      you know the full name.
                    </p>
                  ) : (
                    <p className="text-xs text-muted mt-1">A new customer will be created with this name.</p>
                  )}
                </div>

                <p className="text-xs text-muted">
                  Matching is by normalised registration. Nothing is created until you commit.
                </p>
              </div>
            );
          })()}

          {step === 2 && (
            <div className="space-y-3">
              {blockers.length > 0 && (
                <div className="bg-warn-soft border border-warn rounded-lg p-2">
                  <p className="text-xs text-warn font-medium mb-1">
                    {blockers.length} line{blockers.length === 1 ? '' : 's'} still need a decision:
                  </p>
                  <ul className="text-xs text-warn space-y-0.5">
                    {blockers.map((b) => (
                      <li key={b.lineId}><strong>{b.description}</strong>: {b.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              {topLines.map((l: any) => {
                const mem = d.memory?.find((m: any) => m.lineId === l.id);
                const sugg = mem?.suggestions ?? [];
                const chosen = l.catalogue_item_id
                  ? (d.catalogue ?? []).find((c: any) => c.id === l.catalogue_item_id)
                  : null;
                const open = pickFor === l.id;
                const kids = childrenOf(l.id);
                const list = (d.catalogue ?? []).filter((c: any) => {
                  const t = (c.title || c.name || c.code).toLowerCase();
                  return !q.trim() || t.includes(q.trim().toLowerCase());
                });
                return (
                  <div key={l.id} className="border border-line rounded-lg p-3">
                    <div className="text-sm text-ink">{l.description}</div>
                    <div className="text-xs text-muted mb-2">£{Number(l.unit_price).toFixed(2)} × {Number(l.qty)}</div>

                    {l.is_adjustment ? (
                      <p className="text-xs text-muted">Adjustment — cost pinned to £0.00, no entry needed.</p>
                    ) : kids.length ? (
                      /* SPLIT: the parent is re-expressed by its children, which sum to it exactly. */
                      <div className="border border-line rounded-lg p-2 bg-surface-muted">
                        <div className="text-xs text-ok mb-1">
                          Split into {kids.length} lines — totals £{(kids.reduce((a: number, k: any) => a + Number(k.amount), 0)).toFixed(2)} against the printed £{Number(l.amount).toFixed(2)}
                        </div>
                        {kids.map((k: any) => (
                          <div key={k.id} className="text-xs text-ink flex justify-between gap-2 py-0.5">
                            <span>{k.description} <span className="text-muted">({Number(k.qty)} × £{Number(k.unit_price).toFixed(2)})</span></span>
                            <span className="text-muted">
                              {k.parts_cost != null ? `cost £${Number(k.parts_cost).toFixed(2)}` : ''}
                              {k.labour_hours != null ? ` ${Number(k.labour_hours)}h` : ''}
                              {' '}£{Number(k.amount).toFixed(2)}
                            </span>
                          </div>
                        ))}
                        {!committed && (
                          <button onClick={() => saveSplit(l.id, null)} disabled={busy}
                            className="text-xs text-danger hover:underline mt-1">Undo split (and forget it)</button>
                        )}
                      </div>
                    ) : splitFor === l.id ? (
                      <SplitEditor parentAmount={Number(l.amount)} draft={draft} setDraft={setDraft}
                        catalogue={d.catalogue ?? []} busy={busy}
                        onCancel={() => { setSplitFor(null); setDraft([]); }}
                        onSave={() => saveSplit(l.id, draft)} />
                    ) : chosen ? (
                      /* PRIMARY: an existing product is attached; cost + hours come FROM it. */
                      <div className="bg-ok-soft border border-line rounded-lg p-2">
                        <div className="text-sm text-ok font-medium">{chosen.title || chosen.name}</div>
                        <div className="text-xs text-muted mt-0.5">
                          cost £{Number(chosen.unit_cost).toFixed(2)} · {chosen.labour_hours ?? '—'} h · from the catalogue, not re-entered
                        </div>
                        {!committed && (
                          <button onClick={() => selectItem(l.id, null)} disabled={busy}
                            className="text-xs text-danger hover:underline mt-1">Detach (and forget this mapping)</button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {/* SUGGESTIONS — ranked, never auto-accepted. */}
                        {sugg.length > 0 && (
                          <div>
                            <div className="text-xs text-muted mb-1">Suggested products</div>
                            <div className="flex flex-wrap gap-1">
                              {sugg.map((sg: any) => (
                                <button key={sg.itemId} disabled={busy || committed}
                                  onClick={() => selectItem(l.id, sg.itemId)}
                                  title={sg.weak ? 'Price matches but no words in common — check carefully' : ''}
                                  className={`text-xs px-2 py-1 rounded-full border ${sg.weak ? 'border-warn text-warn bg-warn-soft' : 'border-accent text-accent bg-accent-soft'}`}>
                                  {sg.label} · £{(sg.unitPricePennies / 100).toFixed(2)}
                                  {sg.weak ? ' · price only?' : ''}
                                </button>
                              ))}
                            </div>
                            {sugg.some((x: any) => x.weak) && (
                              <p className="text-xs text-warn mt-1">
                                Amber = the price matches but no words do. On this batch every such pair was a
                                coincidence — check before accepting.
                              </p>
                            )}
                          </div>
                        )}

                        {/* SEARCH the full catalogue. */}
                        {!committed && (open ? (
                          <div className="border border-line rounded-lg p-2">
                            <input autoFocus className={inputCls} placeholder="Search products…" value={q}
                              onChange={(e) => setQ(e.target.value)} />
                            <div className="max-h-48 overflow-y-auto mt-2">
                              {list.map((c: any) => (
                                <button key={c.id} disabled={busy} onClick={() => selectItem(l.id, c.id)}
                                  className="block w-full text-left text-xs px-2 py-1.5 hover:bg-surface-muted rounded">
                                  <span className="text-ink">{c.title || c.name}</span>
                                  <span className="text-muted"> · £{Number(c.unit_price).toFixed(2)} · cost £{Number(c.unit_cost).toFixed(2)}{c.active ? '' : ' · inactive'}</span>
                                </button>
                              ))}
                              {!list.length && <p className="text-xs text-muted p-2">No product matches.</p>}
                            </div>
                            <button onClick={() => { setPickFor(null); setQ(''); }} className="text-xs text-muted hover:text-ink mt-1">Cancel</button>
                          </div>
                        ) : (
                          <div className="flex gap-3">
                            <button onClick={() => { setPickFor(l.id); setQ(''); }}
                              className="text-xs text-accent hover:underline">Choose an existing product…</button>
                            <button onClick={() => {
                              setSplitFor(l.id); setPickFor(null);
                              const tpl = d.splitTemplates?.[`${l.description}|${Number(l.unit_price).toFixed(4)}`];
                              // A stored template may predate amount-first entry (qty + unitPrice
                              // only). Derive the amount when it is missing so an old shape opens
                              // in the new editor rather than reading as £0.
                              setDraft(
                                (tpl as any[])?.map((c: any) => ({
                                  ...c,
                                  amount: c.amount != null
                                    ? String(c.amount)
                                    : ((Math.round((Number(c.qty) || 0) * (Number(c.unitPrice) || 0) * 100)) / 100).toFixed(2),
                                })) ?? [
                                  // Seed: the whole line against the parts child, nothing against
                                  // labour — so "take the remainder" on the second row is the
                                  // natural next gesture.
                                  { description: l.description, qty: Number(l.qty), amount: Number(l.amount).toFixed(2), partsCost: '', labourHours: '' },
                                  { description: 'Labour', qty: 1, amount: '0.00', partsCost: '', labourHours: '' },
                                ],
                              );
                            }} className="text-xs text-accent hover:underline">Split into parts + labour…</button>
                          </div>
                        ))}

                        {/* FALLBACK: no catalogue counterpart — raw entry, which creates a new item. */}
                        <details className="text-xs">
                          <summary className="text-muted cursor-pointer">No matching product — enter cost and hours</summary>
                          <div className="grid grid-cols-3 gap-2 mt-2">
                            <LabelledInput label="Parts cost £" defaultValue={l.parts_cost ?? ''}
                              onBlur={(v) => save({ lines: [{ id: l.id, partsCost: v === '' ? null : Number(v) }] })} disabled={committed} />
                            <LabelledInput label="Labour hours" defaultValue={l.labour_hours ?? ''}
                              onBlur={(v) => save({ lines: [{ id: l.id, labourHours: v === '' ? null : Number(v) }] })} disabled={committed} />
                            <div>
                              <label className="block text-xs text-muted mb-1">Basis</label>
                              <select className={inputCls} defaultValue={l.cost_basis ?? ''} disabled={committed}
                                onChange={(e) => save({ lines: [{ id: l.id, costBasis: e.target.value || null }] })}>
                                <option value="">—</option>
                                <option value="actual">actual</option>
                                <option value="estimated">estimated</option>
                              </select>
                            </div>
                          </div>
                          <p className="text-muted mt-1">This path creates a NEW catalogue item on commit.</p>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {step === 3 && (() => {
            // SAME controls as the booking form: a date input plus a slot select bounded by the
            // site's opening hours. A datetime-local (the earlier control) is used nowhere else in
            // the app and would let you pick a time the garage is shut.
            const slots = startTimeSlots(d.siteHours?.openHour ?? 9, d.siteHours?.closeHour ?? 18, 15);
            const dPart = planned ? planned.toISOString().slice(0, 10) : '';
            const tPart = planned ? planned.toISOString().slice(11, 16) : (slots[0] ?? '09:00');
            const push = (datePart: string, timePart: string) =>
              save({ plannedStartAt: datePart ? new Date(`${datePart}T${timePart || '09:00'}:00.000Z`).toISOString() : null });
            return (
              <div className="space-y-3 text-sm">
                <p className="text-xs text-muted">
                  Defaults to the invoice date. The invoice keeps its printed date whatever you choose here —
                  nothing is shifted automatically.
                </p>
                {plannedWeekend && (
                  <p className="text-xs text-warn">
                    {WD[planned!.getUTCDay()]} — the site is closed. Placement will be refused until you pick a working day.
                  </p>
                )}
                {d.footprintEmpty && <p className="text-xs text-danger">That date/time falls outside working hours.</p>}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-muted mb-1">Date</label>
                    <input type="date" className={inputCls} defaultValue={dPart} disabled={committed}
                      onChange={(e) => push(e.target.value, tPart)} />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">Start time</label>
                    <select className={inputCls} defaultValue={tPart} disabled={committed}
                      onChange={(e) => push(dPart, e.target.value)}>
                      {slots.map((sl) => <option key={sl} value={sl}>{sl}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  {/* Duration: the same option list the booking form uses (durationOptions), so a
                      whole-day choice means N WORKING days rather than 24h of clock. Seeded from
                      the labour hours already entered in step 2, snapped to the site's slot size —
                      overridable, because the real time came from the workshop diary. */}
                  <label className="block text-xs text-muted mb-1">Duration</label>
                  <select className={inputCls} disabled={committed}
                    value={(() => {
                      const cur = s.planned_working_minutes;
                      if (cur == null) return d.duration?.suggested ?? '';
                      const wdm = d.duration?.workingDayMinutes ?? 480;
                      return cur > 0 && cur % wdm === 0 ? `d:${cur / wdm}` : `m:${cur}`;
                    })()}
                    onChange={(e) => save({ plannedDuration: e.target.value || null })}>
                    <option value="">Choose…</option>
                    {(d.duration?.options ?? []).map((o: any) => (
                      <option key={o.value} value={o.value}>
                        {o.kind === 'day'
                          ? `${o.amount} working day${o.amount === 1 ? '' : 's'}`
                          : `${(o.amount / 60).toFixed(o.amount % 60 ? 1 : 0)} h`}
                      </option>
                    ))}
                  </select>
                  {s.planned_working_minutes == null && d.duration?.labourMinutes > 0 && (
                    <p className="text-xs text-muted mt-1">
                      Suggested from {(d.duration.labourMinutes / 60).toFixed(2)}h of labour entered in step 2 —
                      change it to the time the job actually took.
                    </p>
                  )}
                  {s.planned_working_minutes == null && !d.duration?.labourMinutes && (
                    <p className="text-xs text-warn mt-1">
                      No labour hours entered yet, so there is nothing to suggest from. Set the real duration —
                      leaving it unset would place the card as a flat hour.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Lift</label>
                  <select className={inputCls} defaultValue={s.planned_resource_id ?? ''} disabled={committed}
                    onChange={(e) => save({ plannedResourceId: e.target.value || null })}>
                    <option value="">Choose…</option>
                    {(d.lifts ?? []).map((r: any) => (
                      <option key={r.id} value={r.id}>{r.name}{r.free ? '' : ' — taken'}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted mt-1">Availability reads the diary as it stands, including cards placed earlier in this run.</p>
                </div>
              </div>
            );
          })()}

          {step === 4 && (
            <div className="space-y-3 text-sm">
              <p className="text-muted text-xs">
                Photo stages cannot be evidenced for a historical invoice. The gate is not bypassed:
                the stages are recorded as <strong>skipped with a reason</strong>, and the skip is audited.
              </p>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" checked={attest} disabled={committed} onChange={(e) => setAttest(e.target.checked)} className="mt-1" />
                <span>I attest that no photographic evidence exists for this job and that the invoice is the record.</span>
              </label>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3 text-sm">
              <Row label="Xero number" value={s.external_number} />
              <Row label="GreaseDesk number" value="minted on commit — the series stays gapless" tone="muted" />
              <Row label="Invoice date" value={issue.toISOString().slice(0, 10) + ' (printed, immutable)'} />
              <Row label="Reconciled" value={s.reconciled ? 'yes' : 'NO — commit refused'} tone={s.reconciled ? 'ok' : 'danger'} />
              <Row label="Duration"
                value={s.planned_working_minutes == null ? 'NOT SET — required' : `${(s.planned_working_minutes / 60).toFixed(2)}h`}
                tone={s.planned_working_minutes == null ? 'warn' : 'ok'} />
              <Row label="Lines needing a decision" value={blockers.length ? String(blockers.length) : 'none'} tone={blockers.length ? 'warn' : 'ok'} />
              {blockers.length > 0 && (
                <ul className="text-xs text-warn bg-warn-soft border border-warn rounded-lg p-2 space-y-0.5">
                  {blockers.map((b) => (
                    <li key={b.lineId}><strong>{b.description}</strong>: {b.reason}</li>
                  ))}
                </ul>
              )}
              <Row label="Attested" value={attest ? 'yes' : 'no'} tone={attest ? 'ok' : 'warn'} />
              <button
                onClick={commit}
                disabled={busy || committed || skipped || !s.reconciled || !attest || blockers.length > 0 || !s.planned_resource_id || s.planned_working_minutes == null}
                className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">
                {committed ? 'Committed' : busy ? 'Committing…' : 'Commit to the ledger'}
              </button>
              <p className="text-xs text-muted">
                Commit mints through the normal invoice series, freezes the lines, places the card, and marks it paid.
              </p>

              {/* THE OTHER DECISION. Not every invoice belongs in the ledger — a duplicate, a
                  cancelled job, one already entered by hand. Without a way to say so, such an
                  invoice sits pending forever and holds the whole period's derived figures back.
                  A skip is a RECORDED decision: reason required, audited, and reversible. */}
              {!committed && (
                <div className="pt-3 mt-3 border-t border-line">
                  {skipped ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted">
                        Skipped: <strong className="text-ink">{s.skip_reason}</strong>
                      </p>
                      <button onClick={() => save({ status: 'pending' })} disabled={busy}
                        className="text-xs text-muted hover:text-ink underline disabled:opacity-50">
                        Reopen this invoice
                      </button>
                    </div>
                  ) : !skipOpen ? (
                    <button onClick={() => setSkipOpen(true)} disabled={busy}
                      className="text-xs text-muted hover:text-ink underline disabled:opacity-50">
                      Skip this invoice instead
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <label className="block text-xs text-muted">
                        Why is this invoice not being imported? The reason is stored and audited.
                      </label>
                      <input className={inputCls} value={skipReason} placeholder="e.g. duplicate of 100002271"
                        onChange={(e) => setSkipReason(e.target.value)} />
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            await save({ status: 'skipped', skipReason: skipReason.trim() });
                            setSkipOpen(false); setSkipReason('');
                          }}
                          disabled={busy || skipReason.trim().length < 3}
                          className="text-xs bg-warn text-white rounded-lg px-3 py-1.5 disabled:opacity-50">
                          Skip it
                        </button>
                        <button onClick={() => { setSkipOpen(false); setSkipReason(''); }}
                          className="text-xs text-muted hover:text-ink px-2">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsLayout>
  );
}


/**
 * The split editor. Shows a RUNNING TOTAL and RESIDUAL as you type, because the whole point is to
 * watch it balance — the server refuses anything that does not sum to the parent's printed amount
 * to the penny, and this makes that reachable rather than a rejection after the fact.
 * Pennies, not pounds: two thirds of 133.33 look equal in pounds and are not.
 */
function SplitEditor({ parentAmount, draft, setDraft, catalogue, busy, onCancel, onSave }: {
  parentAmount: number; draft: any[]; setDraft: (d: any[]) => void;
  catalogue: any[]; busy: boolean; onCancel: () => void; onSave: () => void;
}) {
  // The SAME arithmetic the server uses, imported rather than re-implemented — the editor showing
  // "balanced" while the server refused would be a disagreement about the same sum.
  const p2 = (n: any) => Math.round((Number(n) || 0) * 100);
  const childP = (c: any) => childAmountPennies({ description: c.description, qty: Number(c.qty) || 0, amount: numOrNull(c.amount) ?? undefined, unitPrice: numOrNull(c.unitPrice) ?? undefined });
  const parentPennies = p2(parentAmount);
  const totalPennies = draft.reduce((a, c) => a + childP(c), 0);
  const residual = parentPennies - totalPennies;
  const balanced = draft.length >= 2 && residual === 0 && draft.every((c) => (c.description ?? '').trim());

  const set = (i: number, patch: any) => setDraft(draft.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => setDraft([...draft, { description: '', qty: 1, amount: '', partsCost: '', labourHours: '' }]);
  const del = (i: number) => setDraft(draft.filter((_, j) => j !== i));
  /** Give this child whatever is left over — the invariant closes by construction, not by luck. */
  const takeRemainder = (i: number) => {
    const others = draft.reduce((a, c, j) => a + (j === i ? 0 : childP(c)), 0);
    set(i, { amount: ((parentPennies - others) / 100).toFixed(2) });
  };
  /** Reported, never typed: 2 for £116.67 is £58.335/unit and the line total stays exact. */
  const unitOf = (c: any) => {
    const qty = Number(c.qty) || 0;
    if (!qty) return null;
    return childP(c) / 100 / qty;
  };

  return (
    <div className="border border-accent rounded-lg p-3 bg-surface">
      <p className="text-xs text-muted mb-2">
        Break this line into what it actually was. The children must total the printed
        £{(parentPennies / 100).toFixed(2)} exactly — the invoice cannot change, only be re-expressed.
        Enter each child's <strong>line total</strong>; the per-unit price is derived from it. Use
        <strong> take the remainder</strong> on the last child and the split closes exactly, whatever
        the parent's price. Cost and hours are <strong>per unit</strong>: at qty 2, £26 of parts is £52 on the line.
      </p>
      {draft.map((c, i) => (
        <div key={i} className="border border-line rounded-lg p-2 mb-2">
          <div className="flex gap-2 mb-1">
            <input className={inputCls} placeholder="Description" value={c.description}
              onChange={(e) => set(i, { description: e.target.value })} />
            <button onClick={() => del(i)} disabled={draft.length <= 2}
              className="text-xs text-danger disabled:opacity-40 px-2">✕</button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="block text-xs text-muted mb-0.5">Qty</label>
              <input className={inputCls} inputMode="decimal" value={c.qty}
                onChange={(e) => set(i, { qty: e.target.value })} />
            </div>
            <div>
              {/* THE LINE TOTAL is the input, because the invariant is on line totals. Entering a
                  unit price meant solving for it: a parent of 2 × £133.3333 needed £58.334 typed,
                  and some parent/qty pairs have no exact unit price at all. */}
              <label className="block text-xs text-muted mb-0.5">Line total £</label>
              <input className={inputCls} inputMode="decimal" value={c.amount ?? ''}
                onChange={(e) => set(i, { amount: e.target.value })} />
              <button onClick={() => takeRemainder(i)}
                className="text-[11px] text-accent hover:underline mt-0.5">
                take the remainder
              </button>
            </div>
            <div>
              {/* PER UNIT, matching how unit_price works and how the catalogue stores unit_cost —
                  £26 against qty 2 is £52 of parts, not £26. Stated, and the total shown, because
                  a bare "Parts cost £" left it to be guessed. */}
              <label className="block text-xs text-muted mb-0.5">Parts cost £ / unit</label>
              <input className={inputCls} inputMode="decimal" value={c.partsCost ?? ''}
                onChange={(e) => set(i, { partsCost: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-muted mb-0.5">Labour h / unit</label>
              <input className={inputCls} inputMode="decimal" value={c.labourHours ?? ''}
                onChange={(e) => set(i, { labourHours: e.target.value })} />
            </div>
          </div>
          <div className="flex items-center justify-between mt-1">
            <select className="text-xs bg-surface border border-line rounded px-2 py-1 text-ink"
              value={c.catalogueItemId ?? ''}
              onChange={(e) => {
                const item = catalogue.find((x: any) => x.id === e.target.value);
                set(i, {
                  catalogueItemId: e.target.value || null,
                  kind: item?.item_type ?? c.kind,
                  partsCost: item ? Number(item.unit_cost).toFixed(2) : c.partsCost,
                  labourHours: item?.labour_hours != null ? String(item.labour_hours) : c.labourHours,
                });
              }}>
              <option value="">No catalogue item</option>
              {catalogue.map((x: any) => (
                <option key={x.id} value={x.id}>{x.title || x.name} · £{Number(x.unit_price).toFixed(2)}</option>
              ))}
            </select>
            <span className="text-xs text-muted">
              {Number(c.partsCost) > 0 && (
                <>cost £{(Number(c.partsCost) * (Number(c.qty) || 0)).toFixed(2)} · </>
              )}
              {Number(c.labourHours) > 0 && (
                <>{(Number(c.labourHours) * (Number(c.qty) || 0)).toFixed(2)}h · </>
              )}
              {unitOf(c) != null && (
                <>£{unitOf(c)!.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/unit derived · </>
              )}
              line £{(childP(c) / 100).toFixed(2)}
            </span>
          </div>
        </div>
      ))}

      <button onClick={add} className="text-xs text-accent hover:underline">+ Add another line</button>

      {/* Running total + residual — the point of the exercise. */}
      <div className={`mt-2 rounded-lg p-2 text-sm ${residual === 0 ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
        <div className="flex justify-between"><span>Children total</span><span>£{(totalPennies / 100).toFixed(2)}</span></div>
        <div className="flex justify-between"><span>Printed line</span><span>£{(parentPennies / 100).toFixed(2)}</span></div>
        <div className="flex justify-between font-semibold">
          <span>Residual</span>
          <span>{residual === 0 ? 'balanced' : `£${(residual / 100).toFixed(2)}`}</span>
        </div>
      </div>

      <div className="flex gap-2 mt-2">
        <button onClick={onSave} disabled={busy || !balanced}
          className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-1.5 disabled:opacity-50">
          Save split
        </button>
        <button onClick={onCancel} className="text-sm text-muted hover:text-ink px-2">Cancel</button>
      </div>
      {!balanced && draft.length >= 2 && residual !== 0 && (
        <p className="text-xs text-warn mt-1">Cannot save until the residual is zero.</p>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' | 'muted' }) {
  const c = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div className="flex justify-between gap-3 border-b border-line pb-2">
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-sm text-right ${c}`}>{value}</span>
    </div>
  );
}
function LabelledInput({ label, defaultValue, onBlur, disabled }: { label: string; defaultValue: any; onBlur: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1">{label}</label>
      <input className={inputCls} inputMode="decimal" defaultValue={defaultValue ?? ''} disabled={disabled}
        onBlur={(e) => onBlur(e.target.value.trim())} />
    </div>
  );
}
function Banner({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' | 'danger' }) {
  const c = tone === 'ok' ? 'bg-ok-soft text-ok' : tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger';
  return <div className={`rounded-lg p-3 text-sm mb-3 ${c}`}>{children}</div>;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const g = await requireAdminPage(ctx);
  if (!g.ok) return { redirect: g.redirect };
  return { props: { isAdmin: g.vis.isAdmin, isManager: g.vis.role === 'SITE_MANAGER' } };
};
