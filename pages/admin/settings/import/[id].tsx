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
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { startTimeSlots } from '@/lib/booking-slots';

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

  async function load() {
    const r = await fetch(`/api/import/staged?id=${id}`);
    const j = await r.json();
    setD(j);
    setStep(j?.staged?.wizard_step ?? 1);
  }
  useEffect(() => { if (id) load(); /* eslint-disable-next-line */ }, [id]);

  async function save(patch: any) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/import/staged', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
      const j = await r.json();
      if (!r.ok) setMsg({ text: j.message ?? 'Save failed.', tone: 'err' });
      else await load();
    } finally { setBusy(false); }
  }

  // Selecting a catalogue item inherits its cost/hours AND applies retroactively to every pending
  // occurrence of the same description + price across all 42 staged invoices.
  async function selectItem(lineId: string, catalogueItemId: string | null) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/import/select-item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catalogueItemId ? { lineId, catalogueItemId } : { lineId, clear: true }),
      });
      const j = await r.json();
      setMsg({ text: j.message ?? 'Done.', tone: r.ok ? 'ok' : 'err' });
      setPickFor(null); setQ('');
      if (r.ok) await load();
    } finally { setBusy(false); }
  }

  async function commit() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/import/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, attest: true }),
      });
      const j = await r.json();
      setMsg({ text: j.message ?? (r.ok ? 'Committed.' : 'Commit failed.'), tone: r.ok ? 'ok' : 'err' });
      if (r.ok) await load();
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
  const issue = new Date(s.issue_date);
  const planned = s.planned_start_at ? new Date(s.planned_start_at) : null;
  const plannedWeekend = planned && (planned.getUTCDay() === 0 || planned.getUTCDay() === 6);
  const vatVar = s.vat_printed != null && s.vat_computed != null &&
    Math.abs(Number(s.vat_printed) - Number(s.vat_computed)) >= 0.005;
  const memOf = (lineId: string) => d.memory?.find((m: any) => m.lineId === lineId)?.hit ?? null;
  const uncosted = s.lines.filter((l: any) => !l.is_adjustment && l.parts_cost == null && l.cost_basis == null);

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
            const partial = parsed !== '' && parsed.split(/\s+/).length < 2;
            // A full name is REQUIRED only where we are creating the customer. Where the ownership
            // edge supplies one, the parsed name is a cross-check and must not overwrite it.
            const needsName = !ownerKnown && (parsed === '' || partial);
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
                  ) : needsName ? (
                    <p className="text-xs text-warn mt-1">
                      {parsed === '' ? 'No name was printed.' : `Only “${parsed}” was printed — a first name, not a full identity.`}
                      {' '}Type the full name before committing; it will create a new customer record.
                    </p>
                  ) : (
                    <p className="text-xs text-ok mt-1">Full name — a new customer will be created with this.</p>
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
              {uncosted.length > 0 && (
                <p className="text-xs text-warn">{uncosted.length} line(s) still need a cost decision.</p>
              )}
              {s.lines.map((l: any) => {
                const mem = d.memory?.find((m: any) => m.lineId === l.id);
                const sugg = mem?.suggestions ?? [];
                const chosen = l.catalogue_item_id
                  ? (d.catalogue ?? []).find((c: any) => c.id === l.catalogue_item_id)
                  : null;
                const open = pickFor === l.id;
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
                          <button onClick={() => { setPickFor(l.id); setQ(''); }}
                            className="text-xs text-accent hover:underline">Choose an existing product…</button>
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
              <Row label="Lines needing a decision" value={String(uncosted.length)} tone={uncosted.length ? 'warn' : 'ok'} />
              <Row label="Attested" value={attest ? 'yes' : 'no'} tone={attest ? 'ok' : 'warn'} />
              <button
                onClick={commit}
                disabled={busy || committed || !s.reconciled || !attest || uncosted.length > 0 || !s.planned_resource_id}
                className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">
                {committed ? 'Committed' : busy ? 'Committing…' : 'Commit to the ledger'}
              </button>
              <p className="text-xs text-muted">
                Commit mints through the normal invoice series, freezes the lines, places the card, and marks it paid.
              </p>
            </div>
          )}
        </div>
      </div>
    </SettingsLayout>
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
