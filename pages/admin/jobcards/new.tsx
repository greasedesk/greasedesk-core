/**
 * File: pages/admin/jobcards/new.tsx
 * Slice 1: create a job card.
 *
 * Captures vehicle/customer fields + flags and POSTs to /api/jobcard, which creates the
 * JobCard (and find-or-creates Customer + Vehicle) scoped to the session's group_id/site_id.
 * Auth-guarded in getServerSideProps, mirroring the Settings page.
 */
import React, { useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { onboardingGateRedirect } from '@/lib/admin-guard';
import { normalizeReg } from '@/lib/vehicle-identity';
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

  // Reg auto-fill: on blur, canonicalise the reg then look it up — OUR records first (returning car →
  // fill owner + vehicle), else DVSA MOT History (make/model/colour/fuel/engine). Best-effort; a failure
  // never blocks manual entry. lastLookedRef guards repeat calls; motMetaRef carries MOT metadata to save.
  const lastLookedRef = useRef('');
  // MOT reference (DVSA) — distinct from the current mileage the mechanic enters. Display + sent on create.
  const [mot, setMot] = useState<{ motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null }>({ motExpiry: null, lastMotMileage: null, lastMotDate: null });
  const [looking, setLooking] = useState(false);
  async function onRegBlur() {
    const r = normalizeReg(form.registration) || '';
    if (r !== form.registration) setForm((p) => ({ ...p, registration: r }));
    if (!r || r === lastLookedRef.current) return;
    lastLookedRef.current = r;
    setLooking(true);
    try {
      const res = await fetch(`/api/vehicle-lookup?reg=${encodeURIComponent(r)}`, { cache: 'no-store' });
      const data = res.ok ? await res.json() : { found: false };
      if (data.found) {
        const v = data.vehicle || {}, o = data.owner || {};
        setForm((p) => ({
          ...p, registration: r,
          customerName: o.name || '', phone: o.phone || '', email: o.email || '',
          vin: v.vin || '', mileage: v.mileage != null ? String(v.mileage) : '',
          make: v.make || '', model: v.model || '', colour: v.colour || '',
          year: v.year != null ? String(v.year) : '', fuel: v.fuel || '', engineCc: v.engineCc != null ? String(v.engineCc) : '',
        }));
        setMot({ motExpiry: null, lastMotMileage: null, lastMotDate: null });
        return;
      }
      // New car → DVSA MOT History (make AND model + MOT metadata).
      setMot({ motExpiry: null, lastMotMileage: null, lastMotDate: null });
      const sres = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(r)}`, { cache: 'no-store' }).catch(() => null);
      const d = sres?.ok ? await sres.json() : { found: false };
      if (d.found) {
        setForm((p) => ({
          ...p,
          make: d.make || p.make, model: d.model || p.model, colour: d.colour || p.colour,
          fuel: d.fuel || p.fuel, year: d.year != null ? String(d.year) : p.year, engineCc: d.engineCc != null ? String(d.engineCc) : p.engineCc,
        }));
        setMot({ motExpiry: d.motExpiry ?? null, lastMotMileage: d.lastMotMileage ?? null, lastMotDate: d.lastMotDate ?? null });
      }
    } catch { /* best-effort — never blocks manual entry */ } finally { setLooking(false); }
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
      router.push(`/admin/jobcards/${data.id}`);
    } catch (err: any) {
      setError(err?.message || 'Failed to create job card.');
      setSaving(false);
    }
  }

  return (
    <>
      <Head>
        <title>New Job Card - GreaseDesk</title>
      </Head>

      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-ink">New Job Card</h1>
          <Link href="/admin/jobcards" className="text-sm text-muted hover:text-ink">
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
              {/* Plate-sized + live-normalised via the same normalizeReg the blur/submit path uses. */}
              <input
                name="registration"
                value={form.registration}
                maxLength={8}
                onChange={(e) => setForm((p) => ({ ...p, registration: normalizeReg(e.target.value) || '' }))}
                onBlur={onRegBlur}
                required
                placeholder="e.g. AB12CDE"
                className={`${inputClass} uppercase max-w-[12rem] tracking-wider`}
              />
              {looking && <p className="text-xs text-muted mt-1">Looking up vehicle…</p>}
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
              {saving ? 'Creating…' : 'Create Job Card'}
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
