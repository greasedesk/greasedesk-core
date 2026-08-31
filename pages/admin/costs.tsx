/**
 * File: pages/admin/costs.tsx
 * COSTS — what the garage pays whether it sells anything or not.
 *
 * ── WHY THE OCCURRENCE IS THE THING ON SCREEN ───────────────────────────────────────────────────
 * The register this replaces held one amount with no date, so a rent rise silently restated every
 * closed month. Here a cost generates INSTANCES, and the two things a garage actually does — "the
 * rent went up in June" and "the electricity bill was £212.40" — are a dated rate change and an
 * edit to one month. Neither can reach backwards.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { prisma } from '@/lib/db';

type Instance = { id: string; period_start: string; period_end: string; due_on: string; amount_pennies: number; is_estimate: boolean; edited_at: string | null };
type Cost = { id: string; name: string; cadence: string; charge: string; active_from: string; active_to: string | null; is_active: boolean;
  rates: { id: string; effective_from: string; amount_pennies: number }[]; instances: Instance[]; allocations: { site_id: string; percent: number }[] };

const money = (p: number) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function CostsPage({ sites }: { sites: { id: string; name: string }[] }) {
  const [costs, setCosts] = useState<Cost[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', cadence: 'monthly', charge: 'spread', activeFrom: thisMonth(), amount: '', siteId: sites[0]?.id ?? '' });

  const load = useCallback(async () => {
    const r = await fetch('/api/costs', { cache: 'no-store' });
    if (r.ok) setCosts((await r.json()).costs ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Every writer clears busy in a `finally`: a same-URL refresh never remounts, so nothing else will.
  const send = async (method: string, body: any) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/costs', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message ?? 'That did not save.');
      await load();
      return true;
    } catch (e: any) { setError(e?.message ?? 'That did not save.'); return false; }
    finally { setBusy(false); }
  };

  // THE ADMIN SHELL IS NOT MOUNTED HERE. _app wraps every /admin route; a page that wraps itself
  // again renders two navs. admin-shell-gate scans for the opening tag, so this note deliberately
  // does not write it out — a comment explaining the rule must not trip the check enforcing it.
  return (
    <>
      <Head><title>Costs - GreaseDesk</title></Head>
      <div className="p-6 max-w-5xl">
        <h1 className="text-2xl font-bold text-ink mb-1">Costs</h1>
        <p className="text-sm text-muted mb-6">
          What the garage pays whether it sells anything or not. Each cost generates one entry per period —
          edit an entry when the real bill arrives, and change the amount from a month when a price rises.
        </p>
        {error && <p className="text-sm text-danger mb-4" data-testid="costs-error">{error}</p>}

        <div className="bg-surface border border-line rounded-xl p-5 mb-8">
          <h2 className="text-sm font-semibold text-ink mb-3">Add a cost</h2>
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
            <div className="sm:col-span-2">
              <label htmlFor="costName" className="block text-xs text-muted mb-1">Name</label>
              <input id="costName" data-testid="cost-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" placeholder="Workshop rent" />
            </div>
            <div>
              <label htmlFor="costAmount" className="block text-xs text-muted mb-1">Amount (ex VAT)</label>
              <input id="costAmount" data-testid="cost-amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" placeholder="2200.00" />
            </div>
            <div>
              <label htmlFor="costCadence" className="block text-xs text-muted mb-1">Every</label>
              <select id="costCadence" data-testid="cost-cadence" value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}
                className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm">
                <option value="monthly">Month</option><option value="quarterly">Quarter</option><option value="annual">Year</option>
              </select>
            </div>
            <div>
              <label htmlFor="costCharge" className="block text-xs text-muted mb-1">Counts as</label>
              <select id="costCharge" data-testid="cost-charge" value={form.charge} onChange={(e) => setForm({ ...form, charge: e.target.value })}
                className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm">
                <option value="spread">Spread across the period</option><option value="falls">Charged where it falls</option>
              </select>
            </div>
            <div>
              <label htmlFor="costFrom" className="block text-xs text-muted mb-1">Applies from</label>
              <input id="costFrom" data-testid="cost-from" type="month" value={form.activeFrom} onChange={(e) => setForm({ ...form, activeFrom: e.target.value })}
                className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
            </div>
          </div>
          <p className="text-xs text-muted mt-2">
            Spread divides the amount evenly across the months it covers — the right answer for “what does a month of
            trading cost me”. Charged where it falls puts the whole amount in the month it is due. A full year totals
            the same either way; only the shape of the months changes.
          </p>
          <button data-testid="cost-add" disabled={busy} onClick={async () => {
            const pennies = Math.round(Number(String(form.amount).replace(/[^0-9.]/g, '')) * 100);
            if (await send('POST', { ...form, amountPennies: pennies, siteId: form.siteId })) setForm({ ...form, name: '', amount: '' });
          }} className="mt-4 px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold disabled:opacity-50">Add cost</button>
        </div>

        {costs.length === 0 ? (
          <p className="text-sm text-muted border border-dashed border-line rounded-xl p-5" data-testid="costs-empty">
            No costs entered yet. Until at least one is here, the dashboard withholds your cost base and break-even
            rather than showing them without your overheads in — a cost base with nothing in it is unknown, not low.
          </p>
        ) : costs.map((c) => (
          <div key={c.id} className="bg-surface border border-line rounded-xl p-5 mb-4" data-testid={`cost-${c.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-ink">{c.name}</h3>
              <span className="text-xs text-muted">{c.cadence} · {c.charge === 'spread' ? 'spread across the period' : 'charged where it falls'} · from {monthLabel(c.active_from)}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 items-end">
              <div>
                <label className="block text-xs text-muted mb-1">Change the amount from</label>
                <input type="month" defaultValue={thisMonth()} data-testid={`rate-from-${c.id}`} id={`rate-from-${c.id}`}
                  className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
              </div>
              <input placeholder="new amount" data-testid={`rate-amount-${c.id}`} id={`rate-amount-${c.id}`}
                className="p-2 bg-surface border border-line rounded-lg text-ink text-sm w-32" />
              <button data-testid={`rate-save-${c.id}`} disabled={busy} onClick={() => {
                const eff = (document.getElementById(`rate-from-${c.id}`) as HTMLInputElement)?.value;
                const amt = (document.getElementById(`rate-amount-${c.id}`) as HTMLInputElement)?.value;
                send('PATCH', { costId: c.id, effectiveFrom: eff, amountPennies: Math.round(Number(String(amt).replace(/[^0-9.]/g, '')) * 100) });
              }} className="px-3 py-2 rounded-lg border border-line text-ink text-sm disabled:opacity-50">Apply from</button>
              <button data-testid={`generate-${c.id}`} disabled={busy} onClick={() => send('PATCH', { costId: c.id })}
                className="px-3 py-2 rounded-lg border border-line text-ink text-sm disabled:opacity-50">Generate forward</button>
            </div>

            {c.instances.length > 0 && (
              <table className="w-full mt-4 text-sm">
                <thead><tr className="text-xs text-muted text-left"><th className="py-1">Period</th><th>Amount</th><th>State</th><th /></tr></thead>
                <tbody data-testid={`instances-${c.id}`}>
                  {c.instances.map((i) => (
                    <tr key={i.id} className="border-t border-line" data-testid={`instance-${i.id}`}>
                      <td className="py-1.5 text-ink">{monthLabel(i.period_start)}</td>
                      <td className="tabular-nums text-ink">{money(i.amount_pennies)}</td>
                      <td className="text-xs text-muted">{i.is_estimate ? 'estimate' : 'confirmed'}</td>
                      <td className="text-right">
                        <input placeholder="actual" data-testid={`actual-${i.id}`} id={`actual-${i.id}`}
                          className="p-1 bg-surface border border-line rounded text-ink text-xs w-24 mr-1" />
                        <button data-testid={`save-${i.id}`} disabled={busy} onClick={() => {
                          const v = (document.getElementById(`actual-${i.id}`) as HTMLInputElement)?.value;
                          send('PATCH', { instanceId: i.id, amountPennies: Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100) });
                        }} className="px-2 py-1 rounded border border-line text-ink text-xs disabled:opacity-50">Save</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const sites = await prisma.site.findMany({ where: { group_id: gate.vis.groupId as string }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true } });
  return { props: { sites: sites.map((s) => ({ id: s.id, name: s.site_name })) } };
});
