/**
 * File: components/jobcard/CustomerDetailsForm.tsx
 * Inline edit for the CURRENT owner + the vehicle, on the Customer Details tab. Mobile-first stacked
 * inputs with correct keyboards (tel/email/number). One Save → POST /api/jobcard-details (edge-resolved
 * owner). Registration collision returns a NON-blocking confirm ("continue anyway?"); on confirm we
 * resubmit with confirmReg. Read-only (no inputs) when the caller lacks operational authority.
 */
import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { normalizeReg } from '@/lib/vehicle-identity';

type Owner = { name: string; phone: string | null; email: string | null; address: string | null };
type Vehicle = {
  registration: string; vin: string | null; mileageIn: number | null;
  make: string | null; model: string | null; colour: string | null; year: number | null; fuel: string | null; engineCc: number | null;
  motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null;
};
type Props = { jobCardId: string; owner: Owner; vehicle: Vehicle; canEdit: boolean; locale: string; onSaved: () => void };

const inputCls = 'w-full p-2.5 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelCls = 'block text-xs uppercase text-muted mb-1';

export default function CustomerDetailsForm({ jobCardId, owner, vehicle, canEdit, onSaved }: Props) {
  const { t } = useTranslation('jobcard');
  const [name, setName] = useState(owner.name === '—' ? '' : owner.name);
  const [phone, setPhone] = useState(owner.phone ?? '');
  const [email, setEmail] = useState(owner.email ?? '');
  const [address, setAddress] = useState(owner.address ?? '');
  const [registration, setRegistration] = useState(vehicle.registration === '—' ? '' : vehicle.registration);
  const [vin, setVin] = useState(vehicle.vin ?? '');
  const [mileageIn, setMileageIn] = useState(vehicle.mileageIn != null ? String(vehicle.mileageIn) : '');
  // Vehicle data (DVSA-populated at creation, lightly editable — a garage can correct a wrong value).
  const [make, setMake] = useState(vehicle.make ?? '');
  const [model, setModel] = useState(vehicle.model ?? '');
  const [colour, setColour] = useState(vehicle.colour ?? '');
  const [vyear, setVYear] = useState(vehicle.year != null ? String(vehicle.year) : '');
  const [fuel, setFuel] = useState(vehicle.fuel ?? '');
  const [engineCc, setEngineCc] = useState(vehicle.engineCc != null ? String(vehicle.engineCc) : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Manual DVSA re-lookup (returning-car backfill: creation skipped DVSA because the record existed).
  // FILL-BLANKS-ONLY on the editable fields — a manual correction is never clobbered. The MOT trio
  // has no manual input, so a lookup always refreshes it (a returning car's MOT data HAS changed);
  // it's saved with the form and displayed immediately below.
  const [mot, setMot] = useState<{ motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null } | null>(null);
  const [lookBusy, setLookBusy] = useState(false);
  async function dvsaLookup() {
    const r = normalizeReg(registration) || '';
    if (!r) return;
    setLookBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(r)}`, { cache: 'no-store' });
      const d = res.ok ? await res.json() : { found: false };
      if (!d.found) { setMsg({ text: t('detailsEdit.dvsaNone'), ok: false }); return; }
      if (!make.trim() && d.make) setMake(d.make);
      if (!model.trim() && d.model) setModel(d.model);
      if (!colour.trim() && d.colour) setColour(d.colour);
      if (!fuel.trim() && d.fuel) setFuel(d.fuel);
      if (!vyear.trim() && d.year != null) setVYear(String(d.year));
      if (!engineCc.trim() && d.engineCc != null) setEngineCc(String(d.engineCc));
      setMot({ motExpiry: d.motExpiry ?? null, lastMotMileage: d.lastMotMileage ?? null, lastMotDate: d.lastMotDate ?? null });
      setMsg({ text: t('detailsEdit.dvsaDone'), ok: true });
    } catch { setMsg({ text: t('detailsEdit.dvsaError'), ok: false }); }
    finally { setLookBusy(false); }
  }
  const motShow = {
    motExpiry: mot ? mot.motExpiry : vehicle.motExpiry,
    lastMotMileage: mot ? mot.lastMotMileage : vehicle.lastMotMileage,
    lastMotDate: mot ? mot.lastMotDate : vehicle.lastMotDate,
  };

  async function submit(confirmReg: boolean) {
    setBusy(true); setMsg(null);
    const body = {
      jobCardId, confirmReg,
      owner: { name, phone, email, address },
      vehicle: {
        registration, vin, mileageIn, make, model, colour, year: vyear, fuel, engineCc,
        ...(mot ? { motExpiry: mot.motExpiry ?? undefined, lastMotMileage: mot.lastMotMileage ?? undefined, lastMotDate: mot.lastMotDate ?? undefined } : {}),
      },
    };
    try {
      const res = await fetch('/api/jobcard-details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.code === 'REG_COLLISION') {
        if (window.confirm(t('detailsEdit.regCollision'))) { await submit(true); return; }
        setMsg({ text: t('detailsEdit.regCancelled'), ok: false }); return;
      }
      if (!res.ok) { setMsg({ text: data?.message || t('detailsEdit.error'), ok: false }); return; }
      setMsg({ text: t('detailsEdit.saved'), ok: true });
      onSaved();
    } catch { setMsg({ text: t('detailsEdit.error'), ok: false }); }
    finally { setBusy(false); }
  }

  if (!canEdit) {
    const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
      <div><div className={labelCls}>{label}</div><div className="text-ink">{value || '—'}</div></div>
    );
    return (
      <div className="bg-surface border border-line rounded-xl p-5">
        <h2 className="text-lg font-semibold text-ink mb-4">{t('tab.details')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Row label={t('field.registration')} value={vehicle.registration} />
          <Row label={t('field.make')} value={vehicle.make} />
          <Row label={t('field.model')} value={vehicle.model} />
          <Row label={t('field.colour')} value={vehicle.colour} />
          <Row label={t('field.year')} value={vehicle.year} />
          <Row label={t('field.fuel')} value={vehicle.fuel} />
          <Row label={t('field.engineCc')} value={vehicle.engineCc} />
          <Row label={t('field.vin')} value={vehicle.vin} />
          <Row label={t('field.mileage')} value={vehicle.mileageIn} />
          <Row label={t('field.motExpiry')} value={vehicle.motExpiry} />
          <Row label={t('field.lastMotMileage')} value={vehicle.lastMotMileage != null ? `${vehicle.lastMotMileage}${vehicle.lastMotDate ? ` · ${vehicle.lastMotDate}` : ''}` : null} />
          <Row label={t('field.customer')} value={owner.name} />
          <Row label={t('field.phone')} value={owner.phone} />
          <Row label={t('field.email')} value={owner.email} />
          <div className="sm:col-span-3"><div className={labelCls}>{t('field.address')}</div><div className="text-ink whitespace-pre-line">{owner.address || '—'}</div></div>
        </div>
        <p className="text-xs text-muted mt-4">{t('field.ownerFromEdge')}</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <h2 className="text-lg font-semibold text-ink mb-1">{t('tab.details')}</h2>
      <p className="text-xs text-muted mb-4">{t('field.ownerFromEdge')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>{t('field.registration')}</label>
          <input className={inputCls} value={registration} onChange={(e) => setRegistration(e.target.value)} autoCapitalize="characters" />
          {/* Deliberate button press — returning cars never auto-fire DVSA (skip-on-existing stays). */}
          <button type="button" disabled={lookBusy || busy || !registration.trim()} onClick={dvsaLookup}
            className="mt-1.5 text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline">
            {lookBusy ? t('detailsEdit.dvsaBusy') : t('detailsEdit.dvsaButton')}
          </button>
        </div>
        <div><label className={labelCls}>{t('field.make')}</label><input className={inputCls} value={make} onChange={(e) => setMake(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.model')}</label><input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.colour')}</label><input className={inputCls} value={colour} onChange={(e) => setColour(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.year')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={vyear} onChange={(e) => setVYear(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.fuel')}</label><input className={inputCls} value={fuel} onChange={(e) => setFuel(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.engineCc')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={engineCc} onChange={(e) => setEngineCc(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.vin')}</label><input className={inputCls} value={vin} onChange={(e) => setVin(e.target.value)} autoCapitalize="characters" /></div>
        <div><label className={labelCls}>{t('field.mileage')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={mileageIn} onChange={(e) => setMileageIn(e.target.value)} /></div>
        {(motShow.motExpiry || motShow.lastMotMileage != null) && (
          <div className="sm:col-span-2 text-xs text-muted">
            {motShow.motExpiry && <span>{t('field.motExpiry')}: <span className="text-ink">{motShow.motExpiry}</span></span>}
            {motShow.lastMotMileage != null && <span className="ml-3">{t('field.lastMotMileage')}: <span className="text-ink">{motShow.lastMotMileage}{motShow.lastMotDate ? ` · ${motShow.lastMotDate}` : ''}</span></span>}
          </div>
        )}
        <div><label className={labelCls}>{t('field.customer')}</label><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.phone')}</label><input className={inputCls} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.email')}</label><input className={inputCls} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className={labelCls}>{t('field.address')}</label><textarea className={`${inputCls} resize-y`} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
      </div>
      {msg && <div className={`mt-3 rounded-lg p-2 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
      <div className="flex justify-end mt-4">
        <button disabled={busy} onClick={() => submit(false)} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
          {busy ? t('detailsEdit.saving') : t('detailsEdit.save')}
        </button>
      </div>
    </div>
  );
}
