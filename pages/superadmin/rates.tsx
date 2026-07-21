/**
 * File: pages/superadmin/rates.tsx
 * Commission rate editor — OWNER ONLY (gSSP enforces minRole 'owner'; the nav link is hidden for
 * others AND this page 404s them). The write surface over the CommissionRate table that the engine
 * reads. Add a rate, add a forward amendment (which never touches the prior row), and correct/remove
 * a FUTURE, UNREFERENCED row only. Every mutation goes through /api/superadmin/rates, which re-enforces
 * owner-only, the append-only-forward timeline, the overlap rule and the audit trail server-side; the
 * UI is a convenience over those guards, never a substitute.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Rate = {
  id: string; country_code: string; currency: string; tier: string;
  effective_from: string; amount_pennies: number; createdAt: string;
  status: 'in_force' | 'superseded' | 'future'; referenced: boolean; editable: boolean;
};
const TIER_LABEL: Record<string, string> = { first_12m: 'First 12 months', thereafter: 'Thereafter' };
const money = (pennies: number, currency: string) => {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pennies / 100); }
  catch { return `${(pennies / 100).toFixed(2)} ${currency}`; }
};
const STATUS: Record<string, { label: string; cls: string }> = {
  in_force: { label: 'In force', cls: 'bg-emerald-900/50 text-emerald-200 border-emerald-800' },
  future: { label: 'Future', cls: 'bg-amber-900/50 text-amber-200 border-amber-800' },
  superseded: { label: 'Superseded', cls: 'bg-slate-800 text-slate-400 border-slate-700' },
};
const input = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';

export default function RatesScreen({ role }: { role: OperatorRoleName }) {
  const [rates, setRates] = useState<Rate[]>([]);
  const [nowStr, setNowStr] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // add form
  const [country, setCountry] = useState('GB'); const [currency, setCurrency] = useState('GBP');
  const [tier, setTier] = useState('first_12m'); const [amount, setAmount] = useState(''); const [eff, setEff] = useState('');

  const refresh = useCallback(async () => {
    const r = await fetch('/api/superadmin/rates');
    if (r.ok) { const d = await r.json(); setRates(d.rates); setNowStr(d.now); }
    setLoading(false);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function send(method: string, body: any): Promise<boolean> {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/superadmin/rates', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false); setMsg({ ok: r.ok, text: d.message || (r.ok ? 'Done.' : 'Failed.') });
    if (r.ok) await refresh();
    return r.ok;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const pounds = parseFloat(amount);
    if (!Number.isFinite(pounds) || pounds < 0) { setMsg({ ok: false, text: 'Enter a valid amount.' }); return; }
    const ok = await send('POST', { country_code: country, currency, tier, amount_pennies: Math.round(pounds * 100), effective_from: eff });
    if (ok) { setAmount(''); setEff(''); }
  }
  function correct(r: Rate) {
    const p = prompt(`Correct amount for ${r.country_code}/${r.currency}/${TIER_LABEL[r.tier]} (pounds). Blank = keep ${money(r.amount_pennies, r.currency)}.`, (r.amount_pennies / 100).toFixed(2));
    if (p === null) return;
    const d = prompt(`Correct effective-from date (YYYY-MM-DD). Blank = keep ${r.effective_from}.`, r.effective_from);
    if (d === null) return;
    const body: any = { id: r.id };
    if (p.trim() !== '' && Number.isFinite(parseFloat(p))) body.amount_pennies = Math.round(parseFloat(p) * 100);
    if (d.trim() !== '' && d.trim() !== r.effective_from) body.effective_from = d.trim();
    if (body.amount_pennies === undefined && body.effective_from === undefined) { setMsg({ ok: false, text: 'Nothing to change.' }); return; }
    send('PATCH', body);
  }
  function remove(r: Rate) {
    if (confirm(`Remove the future ${r.country_code}/${r.currency}/${TIER_LABEL[r.tier]} rate of ${money(r.amount_pennies, r.currency)} effective ${r.effective_from}? This is only allowed because it hasn't taken effect and nothing references it.`)) {
      send('DELETE', { id: r.id });
    }
  }

  // Group by country/currency/tier so the timeline per key is obvious.
  const groups = new Map<string, Rate[]>();
  for (const r of rates) { const k = `${r.country_code}/${r.currency}/${r.tier}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — rates</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-4xl">
        <h1 className="text-xl font-semibold mb-1">Commission rates</h1>
        <p className="text-sm text-slate-400 mb-4">
          Flat commission per collected month, by country, currency and tier. Amending a rate adds a new
          forward-dated row — the prior rate stays frozen up to the new date, so historical commission
          never moves. Only a future, unreferenced rate can be corrected or removed.{nowStr && <> Today is <span className="text-slate-300">{nowStr}</span>.</>}
        </p>
        {msg && <div className={`mb-4 text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}

        {/* Add / forward-amend */}
        <form onSubmit={add} className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-4 flex flex-wrap items-end gap-3">
          <div><label className="block text-xs text-slate-400 mb-1">Country</label><input required value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} className={`${input} w-20`} placeholder="GB" /></div>
          <div><label className="block text-xs text-slate-400 mb-1">Currency</label><input required value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className={`${input} w-24`} placeholder="GBP" /></div>
          <div><label className="block text-xs text-slate-400 mb-1">Tier</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)} className={input}>
              <option value="first_12m">First 12 months</option><option value="thereafter">Thereafter</option>
            </select>
          </div>
          <div><label className="block text-xs text-slate-400 mb-1">Amount ({currency}/month)</label><input required type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${input} w-32`} placeholder="35.00" /></div>
          <div><label className="block text-xs text-slate-400 mb-1">Effective from</label><input required type="date" value={eff} onChange={(e) => setEff(e.target.value)} className={input} /></div>
          <button disabled={busy} className="bg-slate-100 text-slate-900 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">Add rate</button>
        </form>

        {loading ? <div className="text-slate-500 text-sm">Loading…</div> : rates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/60 p-8 text-slate-400 text-sm">No commission rates yet. Add the first rate above — the engine will refuse to compute commission for a country/currency/tier until a rate exists for it.</div>
        ) : (
          <div className="space-y-5">
            {[...groups.entries()].map(([k, rows]) => {
              const [cc, cur, t] = k.split('/');
              return (
                <div key={k} className="rounded-xl border border-slate-800 overflow-hidden">
                  <div className="bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 flex items-center gap-2">
                    <span>{cc} · {cur}</span><span className="text-slate-500">·</span><span className="text-slate-400">{TIER_LABEL[t] ?? t}</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="text-slate-500 text-left"><tr>
                      {['Effective from', 'Amount', 'Status', 'Action'].map((h) => <th key={h} className="px-4 py-1.5 font-medium">{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className={`border-t border-slate-800 ${r.status === 'superseded' ? 'text-slate-500' : ''}`}>
                          <td className="px-4 py-2 whitespace-nowrap">{r.effective_from}</td>
                          <td className="px-4 py-2 whitespace-nowrap font-medium">{money(r.amount_pennies, r.currency)}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium border ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                            {r.referenced && <span className="ml-2 text-[10px] text-slate-500">referenced</span>}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            {r.editable ? (
                              <span className="flex gap-2">
                                <button disabled={busy} onClick={() => correct(r)} className="rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 px-3 py-1 text-xs disabled:opacity-40">Correct</button>
                                <button disabled={busy} onClick={() => remove(r)} className="rounded-lg border border-red-800 text-red-200 hover:bg-red-900/40 px-3 py-1 text-xs disabled:opacity-40">Remove</button>
                              </span>
                            ) : <span className="text-xs text-slate-600" title={r.status === 'future' ? 'Referenced by commission — frozen' : 'In force or past — frozen'}>frozen</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-4 text-xs text-slate-500">The engine resolves a payment against the latest rate whose effective-from is on or before the payment's collection date. A frozen rate can never be edited — the remedy is always a new forward amendment.</p>
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/rates') }); // owner
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
