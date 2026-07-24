/**
 * File: pages/admin/jobcards/new.tsx
 * Slice 1: create a job card.
 *
 * Captures vehicle/customer fields + flags and POSTs to /api/jobcard, which creates the
 * JobCard (and find-or-creates Customer + Vehicle) scoped to the session's group_id/site_id.
 * Auth-guarded in getServerSideProps, mirroring the Settings page.
 *
 * RETURN-DESTINATION PARAMETER (?next=quote). A quote needs exactly the same capture — reg + VRM
 * lookup, customer, vehicle, flags — so Quotes reuses THIS form rather than forking a copy that
 * would drift. The only difference is where you land: ?next=quote drops you on the card's Quote tab
 * ready to price; without it you land on the card overview, exactly as before.
 *
 * The card is created as DRAFT either way. It only becomes `quoted` when the quote is actually sent
 * or marked quoted verbally — so clicking "New quote" never puts an unpriced £0 row in the Quotes
 * list.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { onboardingGateRedirect } from '@/lib/admin-guard';
import { normalizeReg } from '@/lib/vehicle-identity';
import { lookupVehicleByReg } from '@/lib/vehicle-lookup-client';
import { phoneWarn, normalizePhone } from '@/lib/quick-validate';

const inputClass =
  'w-full p-3 bg-surface border border-line rounded-lg text-ink placeholder-muted focus:ring-accent focus:border-accent transition';
const labelClass = 'block text-sm font-medium text-muted mb-1';

type Flags = {
  flag_urgent: boolean;
  flag_sales_car: boolean;
  flag_customer_car: boolean;
  flag_mot: boolean;
  flag_diag: boolean;
};

const FLAG_LABELS: Array<[keyof Flags, string]> = [
  ['flag_urgent', 'Urgent / Priority'],
  ['flag_sales_car', 'Sales Car'],
  ['flag_customer_car', 'Customer Car'],
  ['flag_mot', 'MOT (bay needed)'],
  ['flag_diag', 'DIAG (diagnostic)'],
];

export default function NewJobCardPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    registration: '',
    customerName: '',
    phone: '',
    email: '',
    vin: '',
    mileage: '',
    make: '',
    model: '',
    colour: '',
    year: '',
    fuel: '',
    engineCc: '',
  });
  const [flags, setFlags] = useState<Flags>({
    flag_urgent: false,
    flag_sales_car: false,
    flag_customer_car: false,
    flag_mot: false,
    flag_diag: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleField(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function toggleFlag(key: keyof Flags) {
    setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // EXPLICIT reg lookup — a deliberate button press (or Enter in the field), NEVER auto-fire on blur:
  // a half-typed reg is a wrong reg → misses or the wrong vehicle. Goes through the ONE shared client
  // path (lib/vehicle-lookup-client): OUR records first (returning car → owner + vehicle), else DVSA.
  // FILL-BLANKS-ONLY so a manual correction is never clobbered by pressing Look up again; any miss or
  // failure just shows "enter manually" and never blocks the form.
  const [mot, setMot] = useState<{ motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null }>({ motExpiry: null, lastMotMileage: null, lastMotDate: null });
  const [looking, setLooking] = useState(false);
  const [lookMsg, setLookMsg] = useState<{ text: string; ok: boolean } | null>(null);
  async function runLookup() {
    setLooking(true); setLookMsg(null);
    const r = await lookupVehicleByReg(form.registration);
    setLooking(false);
    if (r.reg && r.reg !== form.registration) setForm((p) => ({ ...p, registration: r.reg }));
    if (!r.ok) {
      setLookMsg({
        ok: false,
        text: r.reason === 'empty-reg' ? 'Enter a registration to look up.'
          : r.reason === 'not-found' ? 'No details found for that registration — enter them manually.'
          : 'Lookup unavailable right now — enter the details manually.',
      });
      return;
    }
    const keep = (cur: string, inc: string) => (cur.trim() ? cur : inc); // fill blanks only
    setForm((p) => ({
      ...p, registration: r.reg,
      customerName: keep(p.customerName, r.owner?.name ?? ''), phone: keep(p.phone, r.owner?.phone ?? ''), email: keep(p.email, r.owner?.email ?? ''),
      vin: keep(p.vin, r.vehicle.vin), mileage: keep(p.mileage, r.vehicle.mileage),
      make: keep(p.make, r.vehicle.make), model: keep(p.model, r.vehicle.model), colour: keep(p.colour, r.vehicle.colour),
      year: keep(p.year, r.vehicle.year), fuel: keep(p.fuel, r.vehicle.fuel), engineCc: keep(p.engineCc, r.vehicle.engineCc),
    }));
    if (r.mot) setMot(r.mot);
    setLookMsg({ ok: true, text: r.source === 'records' ? 'Filled from your records.' : 'Filled from DVSA.' });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/jobcard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form, ...flags,
          phone: normalizePhone(form.phone), // store the ONE canonical phone form
          motExpiry: mot.motExpiry ?? undefined,
          lastMotMileage: mot.lastMotMileage ?? undefined,
          lastMotDate: mot.lastMotDate ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || 'Failed to create job card.');
      // ONE difference between the two entry points: where you land.
      const next = String(router.query.next ?? '');
      router.push(next === 'quote' ? `/admin/jobcards/${data.id}?tab=quote` : `/admin/jobcards/${data.id}`);
    } catch (err: any) {
      setError(err?.message || 'Failed to create job card.');
      setSaving(false);
    }
  }

  return (
    <>
      <Head>
        <title>{router.query.next === 'quote' ? 'New Quote' : 'New Job Card'} - GreaseDesk</title>
      </Head>

      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-ink">{router.query.next === 'quote' ? 'New Quote' : 'New Job Card'}</h1>
          <Link href={router.query.next === 'quote' ? '/admin/quotes' : '/admin/jobcards'} className="text-sm text-muted hover:text-ink">
            ← Back to list
          </Link>
        </div>

        {error && (
          <div className="bg-danger text-white p-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="bg-surface border border-line rounded-xl p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Registration *</label>
              {/* Reg + explicit "Look up" button — the trade convention, and NEVER auto-fire on typing/
                  blur (a part-typed reg is a wrong reg). Enter in the field triggers it too. */}
              <div className="flex items-center gap-2">
                <input
                  name="registration"
                  value={form.registration}
                  maxLength={8}
                  onChange={(e) => setForm((p) => ({ ...p, registration: normalizeReg(e.target.value) || '' }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runLookup(); } }}
                  required
                  placeholder="e.g. AB12CDE"
                  className={`${inputClass} uppercase max-w-[9rem] tracking-wider`}
                />
                <button
                  type="button"
                  onClick={runLookup}
                  disabled={looking || !form.registration.trim()}
                  className="shrink-0 text-sm font-medium bg-surface-muted border border-line rounded-lg px-3 py-2 text-ink hover:bg-surface disabled:opacity-50"
                >
                  {looking ? 'Looking up…' : 'Look up'}
                </button>
              </div>
              {lookMsg && <p className={`text-xs mt-1 ${lookMsg.ok ? 'text-ok' : 'text-muted'}`}>{lookMsg.text}</p>}
            </div>
            <div>
              <label className={labelClass}>Customer name *</label>
              <input name="customerName" value={form.customerName} onChange={handleField} required className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Make</label>
              <input name="make" value={form.make} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Model</label>
              <input name="model" value={form.model} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Colour</label>
              <input name="colour" value={form.colour} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Year</label>
              <input name="year" type="number" min="0" value={form.year} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Fuel</label>
              <input name="fuel" value={form.fuel} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Engine (cc)</label>
              <input name="engineCc" type="number" min="0" value={form.engineCc} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Phone</label>
              <input name="phone" type="tel" inputMode="tel" value={form.phone} onChange={handleField} className={inputClass} />
              {phoneWarn(form.phone) && <p className="text-[11px] text-warn mt-1">That doesn’t look like a phone number.</p>}
            </div>
            <div>
              <label className={labelClass}>Email</label>
              <input name="email" type="email" value={form.email} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>VIN</label>
              <input name="vin" value={form.vin} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Current mileage</label>
              <input name="mileage" type="number" min="0" value={form.mileage} onChange={handleField} className={inputClass} />
            </div>
          </div>

          {(mot.motExpiry || mot.lastMotMileage != null) && (
            <p className="text-xs text-muted">
              {mot.motExpiry && <>MOT expires <span className="text-ink">{mot.motExpiry}</span></>}
              {mot.lastMotMileage != null && <> · Mileage at last MOT <span className="text-ink">{mot.lastMotMileage}{mot.lastMotDate ? ` (${mot.lastMotDate})` : ''}</span></>}
              {' '}— from DVSA
            </p>
          )}

          <div>
            <label className={labelClass}>Flags</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {FLAG_LABELS.map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => toggleFlag(key)}
                  className={`text-sm px-3 py-1.5 rounded-lg border transition ${
                    flags[key]
                      ? 'bg-accent text-white border-accent'
                      : 'bg-surface-muted text-muted border-line hover:border-line'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-5 py-2.5 disabled:opacity-50"
            >
              {saving ? 'Creating…' : (router.query.next === 'quote' ? 'Create & price quote' : 'Create Job Card')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  // Root onboarding gate (item-13) — replaces the old !site_id → setup-location leaf patch.
  const onboard = await onboardingGateRedirect(user.group_id);
  if (onboard) return { redirect: { destination: onboard, permanent: false } };
  return { props: {} };
};
