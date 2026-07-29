/**
 * File: pages/superadmin/setup-steps.tsx
 * Engine Room — the setup-wizard step editor (ruling 2026-07-29). OWNER-only (nav minRole owner;
 * this gssp independently enforces the same). Edits wording, order, required/enabled and country
 * scope; handler_key is shown read-only — it binds a step to code and is not editable here or in
 * the API. Unknown handler keys are flagged (those steps fail closed in the tenant wizard).
 */
import React, { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import { requireOperatorPage, roleAtLeast, type OperatorRoleName } from '@/lib/operator-auth';
import { isHandlerKey } from '@/lib/setup-wizard';

type StepRow = { id: string; step_key: string; handler_key: string; handlerKnown: boolean; title: string; body: string; help_text: string; position: number; required: boolean; enabled: boolean; countries: string[] | null };
type PageProps = { steps: StepRow[]; role: OperatorRoleName };

const input = 'w-full p-2 rounded border text-sm';
const inputStyle = { background: '#0F1B2D', borderColor: '#233247', color: '#E6ECF5' } as React.CSSProperties;

function StepCard({ s }: { s: StepRow }) {
  const [f, setF] = useState({ title: s.title, body: s.body, help_text: s.help_text, position: String(s.position), required: s.required, enabled: s.enabled, countries: s.countries?.join(',') ?? '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/superadmin/setup-steps', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, title: f.title, body: f.body, help_text: f.help_text, position: Number(f.position), required: f.required, enabled: f.enabled, countries: f.countries.trim() === '' ? null : f.countries }),
      });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok ? 'Saved.' : d?.message || 'Failed.');
    } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border p-4 mb-3" style={{ borderColor: '#233247', background: '#12203A' }} data-step-key={s.step_key}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-white">{s.step_key}</span>
        <span className="text-xs font-mono" style={{ color: s.handlerKnown ? '#7C8AA3' : '#F87171' }}>
          {s.handler_key}{!s.handlerKnown && ' — UNKNOWN (fails closed in the wizard)'}
        </span>
      </div>
      <label className="block text-xs mb-1" style={{ color: '#7C8AA3' }}>Title</label>
      <input className={input} style={inputStyle} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <label className="block text-xs mb-1 mt-2" style={{ color: '#7C8AA3' }}>Body (supports {'{{currencySymbol}} {{taxLabel}} {{postcodeLabel}} {{phonePlaceholder}} {{testName}} {{countryName}}'})</label>
      <textarea className={input} style={inputStyle} rows={2} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      <label className="block text-xs mb-1 mt-2" style={{ color: '#7C8AA3' }}>Help text</label>
      <input className={input} style={inputStyle} value={f.help_text} onChange={(e) => setF({ ...f, help_text: e.target.value })} />
      <div className="flex flex-wrap items-center gap-4 mt-3 text-xs" style={{ color: '#B9C4D6' }}>
        <label>Position <input type="number" className="w-16 p-1 rounded border ml-1" style={inputStyle} value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></label>
        <label><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> required</label>
        <label><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> enabled</label>
        <label>Countries <input className="w-28 p-1 rounded border ml-1" style={inputStyle} placeholder="all" value={f.countries} onChange={(e) => setF({ ...f, countries: e.target.value })} /></label>
        <button onClick={save} disabled={busy} className="rounded px-3 py-1.5 text-xs font-semibold text-white" style={{ background: '#2563EB' }}>Save</button>
        {msg && <span>{msg}</span>}
      </div>
    </div>
  );
}

export default function SetupStepsAdmin({ steps, role }: PageProps) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Setup steps — Engine Room</title></Head>
      <h1 className="text-xl font-semibold text-white mb-1">Setup wizard steps</h1>
      <p className="text-sm mb-5" style={{ color: '#7C8AA3' }}>
        Wording, order, required/enabled and country scope are editable. What a step writes to
        (handler) is code — retiring a handler makes its steps disappear from the wizard, never break it.
      </p>
      {steps.map((s) => <StepCard key={s.id} s={s} />)}
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx);
  if (!gate.ok) return { notFound: true };
  if (!roleAtLeast(gate.op.role, 'owner')) return { notFound: true }; // owner-only screen, undiscoverable below
  const rows = await prisma.setupStepDef.findMany({ orderBy: [{ position: 'asc' }, { step_key: 'asc' }] });
  return {
    props: {
      role: gate.op.role,
      steps: rows.map((r: any) => ({
        id: r.id, step_key: r.step_key, handler_key: r.handler_key, handlerKnown: isHandlerKey(r.handler_key),
        title: r.title, body: r.body, help_text: r.help_text, position: r.position,
        required: r.required, enabled: r.enabled, countries: (r.countries as string[] | null) ?? null,
      })),
    },
  };
};
