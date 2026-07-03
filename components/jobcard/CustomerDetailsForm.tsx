/**
 * File: components/jobcard/CustomerDetailsForm.tsx
 * Inline edit for the CURRENT owner + the vehicle, on the Customer Details tab. Mobile-first stacked
 * inputs with correct keyboards (tel/email/number). One Save → POST /api/jobcard-details (edge-resolved
 * owner). Registration collision returns a NON-blocking confirm ("continue anyway?"); on confirm we
 * resubmit with confirmReg. Read-only (no inputs) when the caller lacks operational authority.
 */
import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';

type Owner = { name: string; phone: string | null; email: string | null; address: string | null };
type Vehicle = { registration: string; vin: string | null; mileageIn: number | null };
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function submit(confirmReg: boolean) {
    setBusy(true); setMsg(null);
    const body = { jobCardId, confirmReg, owner: { name, phone, email, address }, vehicle: { registration, vin, mileageIn } };
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
          <Row label={t('field.vin')} value={vehicle.vin} />
          <Row label={t('field.mileage')} value={vehicle.mileageIn} />
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
        <div><label className={labelCls}>{t('field.registration')}</label><input className={inputCls} value={registration} onChange={(e) => setRegistration(e.target.value)} autoCapitalize="characters" /></div>
        <div><label className={labelCls}>{t('field.vin')}</label><input className={inputCls} value={vin} onChange={(e) => setVin(e.target.value)} autoCapitalize="characters" /></div>
        <div><label className={labelCls}>{t('field.mileage')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={mileageIn} onChange={(e) => setMileageIn(e.target.value)} /></div>
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
