/**
 * File: pages/admin/setup-wizard.tsx
 * The post-payment setup wizard (ruling 2026-07-29) — the guided front-end that superseded the
 * ?walk=1 walkthrough. Steps come from the Engine Room (SetupStepDef, operator wording/order/scope);
 * every write goes through a FIXED handler (the editability boundary lives in lib/setup-wizard).
 * NOT BLOCKING: the app is fully usable throughout; abandon any time; resume is DERIVED (first
 * required-incomplete step). Re-entry loads existing state — reconcile, never append.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { requireAdminPage } from '@/lib/admin-guard';

type Step = { stepKey: string; handlerKey: string; title: string; body: string; helpText: string; required: boolean; complete: boolean };
type Person = { id: string; name: string; role: string | null; salaryPennies: number; isChargeable: boolean; hoursPerDay: number | null; workingDays: number[]; startDate: string | null; left: boolean; login: { email: string; role: string; canInvoice: boolean; status: string } | null };
type WizardData = {
  steps: Step[];
  state: any;
  resumeKey: string | null;
  phonePlaceholder: string;
  currencySymbol: string;
  primarySiteId: string;
};

const inputClass = 'w-full p-2.5 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelClass = 'block text-xs font-medium text-muted mb-1 mt-3';
const btnPrimary = 'bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50';
const btnGhost = 'text-sm text-muted hover:text-ink px-3 py-2';
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function SetupWizardPage() {
  const [data, setData] = useState<WizardData | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (goToResume: boolean) => {
    const r = await fetch('/api/setup-wizard');
    if (!r.ok) { setErr('Could not load the wizard.'); return; }
    const d: WizardData = await r.json();
    setData(d);
    if (goToResume) setActiveKey(d.resumeKey ?? d.steps[0]?.stepKey ?? null);
  }, []);
  useEffect(() => { void load(true); }, [load]);

  const steps = data?.steps ?? [];
  const idx = useMemo(() => steps.findIndex((s) => s.stepKey === activeKey), [steps, activeKey]);
  const step = idx >= 0 ? steps[idx] : null;
  const next = () => { if (idx < steps.length - 1) setActiveKey(steps[idx + 1].stepKey); else setActiveKey(null); };
  const back = () => { if (idx > 0) setActiveKey(steps[idx - 1].stepKey); };

  if (!data) return <div className="p-8 text-muted">{err ?? 'Loading…'}</div>;

  const allRequiredDone = steps.every((s) => !s.required || s.complete);

  return (
    <>
      <Head><title>Setup - GreaseDesk</title></Head>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-ink">Set up your workshop</h1>
          <Link href="/admin/dashboard" className="text-sm text-muted hover:text-ink">Do this later →</Link>
        </div>
        {/* Progress rail — every step, ticked from DERIVED completeness */}
        <div className="flex flex-wrap gap-2 mb-6">
          {steps.map((s) => (
            <button key={s.stepKey} onClick={() => setActiveKey(s.stepKey)}
              className={`text-xs rounded-full px-3 py-1.5 border ${s.stepKey === activeKey ? 'bg-accent text-white border-accent' : s.complete ? 'bg-ok-soft text-ok border-line' : 'bg-surface text-muted border-line'}`}>
              {s.complete ? '✓ ' : ''}{s.title.length > 34 ? s.title.slice(0, 32) + '…' : s.title}
            </button>
          ))}
        </div>

        {step ? (
          <div className="bg-surface border border-line rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-ink mb-1">{step.title}</h2>
            {step.body && <p className="text-sm text-muted mb-4">{step.body}</p>}
            {err && <div className="bg-danger-soft text-danger rounded-lg p-2.5 text-sm mb-3">{err}</div>}
            <StepBody step={step} data={data} busy={busy} setBusy={setBusy} setErr={setErr} reload={() => load(false)} advance={next} />
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-line">
              <button onClick={back} disabled={idx <= 0} className={btnGhost}>← Back</button>
              <div className="flex items-center gap-2">
                {!step.required && <button onClick={next} className={btnGhost}>Skip</button>}
                {step.helpText && <span className="text-xs text-muted hidden sm:block max-w-[16rem]">{step.helpText}</span>}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surface border border-line rounded-2xl p-8 text-center">
            <h2 className="text-lg font-semibold text-ink mb-2">{allRequiredDone ? 'All set.' : 'Progress saved.'}</h2>
            <p className="text-sm text-muted mb-4">{allRequiredDone ? 'Your diary, capacity and cost figures are live.' : 'Come back any time — the wizard picks up where you left off.'}</p>
            <Link href="/admin/dashboard" className={btnPrimary}>Go to the dashboard</Link>
          </div>
        )}
      </div>
    </>
  );
}

function StepBody({ step, data, busy, setBusy, setErr, reload, advance }: {
  step: Step; data: WizardData; busy: boolean; setBusy: (b: boolean) => void; setErr: (e: string | null) => void; reload: () => Promise<void> | void; advance: () => void;
}) {
  const h = step.handlerKey;
  if (h === 'resources_lifts' || h === 'resources_booths') return <CountStep handler={h} state={data.state[h]} busy={busy} setBusy={setBusy} setErr={setErr} reload={reload} advance={advance} />;
  if (h === 'resources_other') return <OtherStep state={data.state[h]} busy={busy} setBusy={setBusy} setErr={setErr} reload={reload} advance={advance} />;
  if (h === 'technicians') return <TechStep state={data.state[h]} currencySymbol={data.currencySymbol} busy={busy} setBusy={setBusy} setErr={setErr} reload={reload} advance={advance} />;
  if (h === 'overheads_basic') return <CostsStep state={data.state[h]} currencySymbol={data.currencySymbol} primarySiteId={data.primarySiteId} busy={busy} setBusy={setBusy} setErr={setErr} reload={reload} advance={advance} />;
  if (h === 'contact_details') return <ContactStep state={data.state[h]} phonePlaceholder={data.phonePlaceholder} busy={busy} setBusy={setBusy} setErr={setErr} reload={reload} advance={advance} />;
  return <p className="text-sm text-muted">This step isn’t available.</p>;
}

// ---- Steps 1–2: count reconcile ----
function CountStep({ handler, state, busy, setBusy, setErr, reload, advance }: any) {
  const [count, setCount] = useState(String(state?.count ?? 0));
  useEffect(() => { setCount(String(state?.count ?? 0)); }, [state?.count]);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/setup-wizard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handler, count: Number(count) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || 'Could not save.'); return; }
      await reload(); advance();
    } finally { setBusy(false); }
  }
  return (
    <div>
      <input type="number" min={0} max={50} value={count} onChange={(e) => setCount(e.target.value)} className={`${inputClass} w-32`} data-testid="count-input" />
      {state?.items?.length > 0 && (
        <p className="text-xs text-muted mt-2">Current: {state.items.filter((i: any) => i.is_active).map((i: any) => i.name).join(', ') || 'none'}
          {state.items.some((i: any) => !i.is_active) && <span> · inactive: {state.items.filter((i: any) => !i.is_active).map((i: any) => i.name).join(', ')}</span>}</p>
      )}
      <div className="mt-4"><button onClick={save} disabled={busy} className={btnPrimary} data-testid="save-step">Save & continue</button></div>
    </div>
  );
}

// ---- Step 3: named list ----
function OtherStep({ state, busy, setBusy, setErr, reload, advance }: any) {
  const [items, setItems] = useState<any[]>(state?.items?.map((i: any) => ({ ...i, active: i.is_active })) ?? []);
  useEffect(() => { setItems(state?.items?.map((i: any) => ({ ...i, active: i.is_active })) ?? []); }, [state?.items]);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/setup-wizard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handler: 'resources_other', items: items.map((i) => ({ id: i.id, name: i.name, type: i.type, active: i.active })) }) });
      if (!r.ok) { setErr((await r.json().catch(() => ({})))?.message || 'Could not save.'); return; }
      await reload(); advance();
    } finally { setBusy(false); }
  }
  return (
    <div className="space-y-2">
      {items.map((i, n) => (
        <div key={i.id ?? `new-${n}`} className="flex items-center gap-2">
          <input value={i.name} onChange={(e) => setItems((p) => p.map((x, m) => m === n ? { ...x, name: e.target.value } : x))} className={inputClass} placeholder="e.g. Rolling road" />
          <label className="text-xs text-muted flex items-center gap-1 shrink-0"><input type="checkbox" checked={i.active !== false} onChange={(e) => setItems((p) => p.map((x, m) => m === n ? { ...x, active: e.target.checked } : x))} /> Active</label>
        </div>
      ))}
      <button onClick={() => setItems((p) => [...p, { name: '', type: 'other', active: true }])} className="text-sm text-accent hover:underline">+ Add resource</button>
      <div className="mt-4"><button onClick={save} disabled={busy} className={btnPrimary} data-testid="save-step">Save & continue</button></div>
    </div>
  );
}

// ---- Step 4/4a: technicians ----
function TechStep({ state, currencySymbol, busy, setBusy, setErr, reload, advance }: any) {
  const people: Person[] = state?.people ?? [];
  const siteDays: number[] = state?.siteOpenDays ?? [1, 2, 3, 4, 5, 6];
  const blank = { name: '', jobTitle: '', salaryPounds: '', startDate: '', isChargeable: true, hoursPerDay: '8', workingDays: siteDays, login: 'STANDARD', email: '', canInvoice: false };
  const [form, setForm] = useState<any>(blank);
  const [adding, setAdding] = useState(people.length === 0);
  const set = (k: string, v: any) => setForm((p: any) => ({ ...p, [k]: v }));

  async function add() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/setup-wizard/technician', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || 'Could not add technician.'); return; }
      setForm(blank); setAdding(false);
      await reload();
    } finally { setBusy(false); }
  }
  return (
    <div>
      {people.length > 0 && (
        <ul className="space-y-2 mb-4" data-testid="tech-list">
          {people.map((p) => (
            <li key={p.id} className={`border border-line rounded-lg p-3 text-sm flex items-center justify-between ${p.left ? 'opacity-50' : ''}`} data-left={p.left ? '1' : '0'}>
              <span>
                <span className="font-medium text-ink">{p.name}</span>
                {p.left && <span className="ml-2 text-xs text-muted">left</span>}
                {!p.left && p.isChargeable && p.hoursPerDay == null && <span className="ml-2 text-xs text-warn">hours needed for capacity</span>}
                {p.login && !p.left && <span className="ml-2 text-xs text-muted">{p.login.status === 'invited' ? 'invite sent' : p.login.role.toLowerCase()}</span>}
              </span>
              <span className="text-xs text-muted">Edit in <Link href="/admin/hr" className="text-accent hover:underline">HR</Link></span>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="border border-line rounded-xl p-4">
          <label className={labelClass}>Name *</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} className={inputClass} data-testid="tech-name" />
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Annual salary ({currencySymbol}) *</label>
              <input type="number" min={0} value={form.salaryPounds} onChange={(e) => set('salaryPounds', e.target.value)} className={inputClass} data-testid="tech-salary" /></div>
            <div><label className={labelClass}>Start date</label>
              <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} className={inputClass} /></div>
          </div>
          <label className="flex items-center gap-2 mt-3 text-sm text-ink"><input type="checkbox" checked={form.isChargeable} onChange={(e) => set('isChargeable', e.target.checked)} data-testid="tech-chargeable" /> Works on the floor (their hours count towards capacity)</label>
          {form.isChargeable && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelClass}>Contracted hours per day *</label>
                <input type="number" min={0} max={24} step="0.25" value={form.hoursPerDay} onChange={(e) => set('hoursPerDay', e.target.value)} className={inputClass} data-testid="tech-hours" /></div>
              <div><label className={labelClass}>Working days</label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <label key={d} className={`text-xs px-2 py-1 rounded border cursor-pointer ${form.workingDays.includes(d) ? 'bg-accent text-white border-accent' : 'bg-surface text-muted border-line'}`}>
                      <input type="checkbox" className="sr-only" checked={form.workingDays.includes(d)} onChange={(e) => set('workingDays', e.target.checked ? [...form.workingDays, d] : form.workingDays.filter((x: number) => x !== d))} />{DAY_LABELS[d]}
                    </label>
                  ))}
                </div></div>
            </div>
          )}
          <label className={labelClass}>Login</label>
          <select value={form.login} onChange={(e) => set('login', e.target.value)} className={inputClass} data-testid="tech-login">
            <option value="STANDARD">Mechanic (standard access)</option>
            <option value="SITE_MANAGER">Site manager</option>
            <option value="ADMIN">Admin</option>
            <option value="none">No login — payroll only</option>
          </select>
          {form.login !== 'none' && (
            <>
              <label className={labelClass}>Email (for their invitation) *</label>
              <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className={inputClass} data-testid="tech-email" />
              {form.login === 'STANDARD' && (
                <label className="flex items-center gap-2 mt-2 text-sm text-ink"><input type="checkbox" checked={form.canInvoice} onChange={(e) => set('canInvoice', e.target.checked)} /> May raise invoices</label>
              )}
            </>
          )}
          <div className="flex gap-2 mt-4">
            <button onClick={add} disabled={busy} className={btnPrimary} data-testid="tech-add">Add technician</button>
            {people.length > 0 && <button onClick={() => setAdding(false)} className={btnGhost}>Done adding</button>}
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setAdding(true)} className="text-sm text-accent hover:underline">+ Add another technician</button>
          <button onClick={advance} disabled={people.filter((p) => !p.left).length === 0} className={btnPrimary} data-testid="save-step">Continue</button>
        </div>
      )}
    </div>
  );
}

// ---- Step 5: costs (existing /api/overheads rows, edit-in-place) ----
function CostsStep({ state, currencySymbol, primarySiteId, busy, setBusy, setErr, reload, advance }: any) {
  const items = state?.items ?? [];
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('monthly');
  async function add() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/overheads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, exVatAmountPennies: Math.round(Number(amount) * 100), period, allocations: [{ siteId: primarySiteId, percent: 100 }] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || 'Could not add cost.'); return; }
      setName(''); setAmount('');
      await reload();
    } finally { setBusy(false); }
  }
  return (
    <div>
      {items.length > 0 && (
        <ul className="space-y-1.5 mb-4 text-sm" data-testid="cost-list">
          {items.map((o: any) => (
            <li key={o.id} className="flex justify-between border border-line rounded-lg px-3 py-2">
              <span className="text-ink">{o.name}</span>
              <span className="text-muted">{currencySymbol}{(o.exVatAmountPennies / 100).toFixed(2)} / {o.period}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="e.g. Rent" data-testid="cost-name" />
        <input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} placeholder={`Amount (${currencySymbol}, ex tax)`} data-testid="cost-amount" />
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className={inputClass}>
          <option value="weekly">per week</option>
          <option value="monthly">per month</option>
          <option value="annual">per year</option>
        </select>
      </div>
      <div className="flex gap-2 mt-4">
        <button onClick={add} disabled={busy || !name || !amount} className="text-sm text-accent hover:underline" data-testid="cost-add">+ Add cost</button>
        <button onClick={advance} disabled={items.length === 0} className={btnPrimary} data-testid="save-step">Continue</button>
      </div>
    </div>
  );
}

// ---- Step 6: contact (existing /api/company) ----
function ContactStep({ state, phonePlaceholder, busy, setBusy, setErr, reload, advance }: any) {
  const [phone, setPhone] = useState(state?.phone ?? '');
  const [wa, setWa] = useState(state?.whatsapp ?? '');
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/company', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, whatsapp: wa }) });
      if (!r.ok) { setErr((await r.json().catch(() => ({})))?.message || 'Could not save.'); return; }
      await reload(); advance();
    } finally { setBusy(false); }
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><label className={labelClass}>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder={phonePlaceholder} /></div>
      <div><label className={labelClass}>WhatsApp</label><input value={wa} onChange={(e) => setWa(e.target.value)} className={inputClass} placeholder={phonePlaceholder} /></div>
      <div className="sm:col-span-2"><button onClick={save} disabled={busy} className={btnPrimary} data-testid="save-step">Save & finish</button></div>
    </div>
  );
}

// Post-payment only (requireAdminPage folds in the onboarding gate) — the wizard is never a blocker,
// the gate is: you reach here exactly when the app itself is already fully usable.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
};
