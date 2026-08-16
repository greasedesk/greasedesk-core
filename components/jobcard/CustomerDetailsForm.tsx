/**
 * File: components/jobcard/CustomerDetailsForm.tsx
 * Inline edit for the CURRENT owner + the vehicle, on the Customer Details tab. Mobile-first stacked
 * inputs with correct keyboards (tel/email/number). One Save → POST /api/jobcard-details (edge-resolved
 * owner). Registration collision returns a NON-blocking confirm ("continue anyway?"); on confirm we
 * resubmit with confirmReg. Read-only (no inputs) when the caller lacks operational authority.
 */
import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { lookupVehicleByReg, lookupVehicleByVin } from '@/lib/vehicle-lookup-client';
import { phoneWarn, normalizePhone } from '@/lib/quick-validate';
import { lookupKeyFor, isPlausibleVin, type LookupProviderName } from '@/lib/vehicle-lookup-providers';

// phoneE164 is DERIVED and read-only on this form — shown so staff can see whether the number is
// actually dialable. smsOptOut/emailOptOut are THREE-STATE: null = no record (unknown), never
// rendered as "opted in".
type Owner = {
  name: string; phone: string | null; phoneE164?: string | null; email: string | null; address: string | null;
  accountTermsDays?: number | null; accountName?: string | null;
  smsOptOut?: boolean | null; emailOptOut?: boolean | null;
};
type Vehicle = {
  registration: string; vin: string | null; mileageIn: number | null;
  make: string | null; model: string | null; colour: string | null; year: number | null; fuel: string | null; engineCc: number | null;
  motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null;
};
type Props = { jobCardId: string; owner: Owner; vehicle: Vehicle; canEdit: boolean; locale: string; onSaved: () => void;
  // Country-shaped vehicle identity (ruling 2026-07-29); defaults keep every existing caller working.
  vehicleIdLabel?: string; vehicleLookupProvider?: LookupProviderName;
  /**
   * The stage transition for this tab, rendered beside Save. Passed in rather than built here: the
   * button reads the card's stage state and calls the workspace's own setStage, and moving that
   * logic into this form would give the workspace a second way to change a card's spine.
   */
  stageAction?: React.ReactNode };

const inputCls = 'w-full p-2.5 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelCls = 'block text-xs uppercase text-muted mb-1';

/**
 * HONEST-NULL rendering of contact preference. Three states, three different sentences — "no record"
 * is NEVER shown as "opted in", because nobody has asked this customer anything. Only an explicit
 * refusal is stated as a refusal.
 */
function contactPrefSummary(o: { smsOptOut?: boolean | null; emailOptOut?: boolean | null }, t: (k: string) => string): string {
  const out: string[] = [];
  if (o.smsOptOut === true) out.push(t('field.optOutSmsShort'));
  if (o.emailOptOut === true) out.push(t('field.optOutEmailShort'));
  if (out.length) return out.join(' · ');
  return o.smsOptOut == null && o.emailOptOut == null ? t('field.optOutNoRecord') : t('field.optOutNone');
}

export default function CustomerDetailsForm({ jobCardId, owner, vehicle, canEdit, onSaved, vehicleIdLabel = 'Registration', vehicleLookupProvider = 'none', stageAction }: Props) {
  const { t } = useTranslation('jobcard');
  const [name, setName] = useState(owner.name === '—' ? '' : owner.name);
  const [phone, setPhone] = useState(owner.phone ?? '');
  const [email, setEmail] = useState(owner.email ?? '');
  const [address, setAddress] = useState(owner.address ?? '');
  // Blank = retail, paid on collection. See lib/account-terms: the absence of terms is the normal
  // case, not missing data, so this field starts empty and stays empty for almost every customer.
  const [termsDays, setTermsDays] = useState(owner.accountTermsDays != null ? String(owner.accountTermsDays) : '');
  const [accountName, setAccountName] = useState(owner.accountName ?? '');
  // Contact preferences. `?? null` preserves the unknown state — a customer nobody has asked must
  // not be turned into an explicit "opted in" just by opening the form and saving.
  const [smsOptOut, setSmsOptOut] = useState<boolean | null>(owner.smsOptOut ?? null);
  const [emailOptOut, setEmailOptOut] = useState<boolean | null>(owner.emailOptOut ?? null);
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
  async function vinLookup() {
    if (!vin.trim()) return;
    setLookBusy(true);
    const r = await lookupVehicleByVin(vin);
    setLookBusy(false);
    if (!r.ok) return;
    if (!make && r.vehicle.make) setMake(r.vehicle.make);
    if (!model && r.vehicle.model) setModel(r.vehicle.model);
    if (!vyear && r.vehicle.year) setVYear(r.vehicle.year);
    if (!fuel && r.vehicle.fuel) setFuel(r.vehicle.fuel);
    if (!engineCc && r.vehicle.engineCc) setEngineCc(r.vehicle.engineCc);
  }

  async function dvsaLookup() {
    setLookBusy(true); setMsg(null);
    // The record already exists → DVSA only (internal: false), through the ONE shared client path.
    const r = await lookupVehicleByReg(registration, { internal: false });
    setLookBusy(false);
    if (!r.ok) {
      if (r.reason === 'empty-reg') return;
      setMsg({ text: t(r.reason === 'error' ? 'detailsEdit.dvsaError' : 'detailsEdit.dvsaNone'), ok: false });
      return;
    }
    // FILL-BLANKS-ONLY on the editable fields — a manual correction is never clobbered. The MOT trio
    // has no manual input, so a lookup always refreshes it (a returning car's MOT data HAS changed).
    if (!make.trim() && r.vehicle.make) setMake(r.vehicle.make);
    if (!model.trim() && r.vehicle.model) setModel(r.vehicle.model);
    if (!colour.trim() && r.vehicle.colour) setColour(r.vehicle.colour);
    if (!fuel.trim() && r.vehicle.fuel) setFuel(r.vehicle.fuel);
    if (!vyear.trim() && r.vehicle.year) setVYear(r.vehicle.year);
    if (!engineCc.trim() && r.vehicle.engineCc) setEngineCc(r.vehicle.engineCc);
    if (r.mot) setMot(r.mot);
    setMsg({ text: t('detailsEdit.dvsaDone'), ok: true });
  }
  const motShow = {
    motExpiry: mot ? mot.motExpiry : vehicle.motExpiry,
    lastMotMileage: mot ? mot.lastMotMileage : vehicle.lastMotMileage,
    lastMotDate: mot ? mot.lastMotDate : vehicle.lastMotDate,
  };

  async function submit(confirmReg: boolean) {
    setBusy(true); setMsg(null);
    const body = {
      source: 'details-form', // names the control in the audit trail
      jobCardId, confirmReg,
      // PHONE GOES UP RAW, exactly as typed. This used to send normalizePhone(phone), which stripped
      // the operator's spacing on the CLIENT — "07747 732864" reached the server as "07747732864" and
      // the form the garage recognises was gone before anything could keep it. The server now stores
      // the raw string AND derives the dialable form beside it (lib/contact-routes).
      owner: {
        name, phone, email, address, sms_opt_out: smsOptOut, email_opt_out: emailOptOut,
        // Sent as typed; the server normalises through the one rule. '' becomes NULL — clearing the
        // box takes a customer OFF account, which is the only way back to paying on collection.
        account_terms_days: termsDays, account_name: accountName,
      },
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
          <Row label={vehicleIdLabel} value={vehicle.registration} />
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
          <Row label={t('field.contactPrefs')} value={contactPrefSummary(owner, t)} />
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
          <label className={labelCls} data-testid="veh-id-label">{vehicleIdLabel}</label>
          <input className={inputCls} value={registration} onChange={(e) => setRegistration(e.target.value)} autoCapitalize="characters" />
          {/* Deliberate button press — returning cars never auto-fire DVSA (skip-on-existing stays).
              Hidden where the country has no lookup provider: DVLA/DVSA are keyed on UK plates. */}
          {lookupKeyFor(vehicleLookupProvider) === 'registration' && (
            <button type="button" disabled={lookBusy || busy || !registration.trim()} onClick={dvsaLookup} data-testid="veh-lookup"
              className="mt-1.5 text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline">
              {lookBusy ? t('detailsEdit.dvsaBusy') : t('detailsEdit.dvsaButton')}
            </button>
          )}
        </div>
        <div><label className={labelCls}>{t('field.make')}</label><input className={inputCls} value={make} onChange={(e) => setMake(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.model')}</label><input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.colour')}</label><input className={inputCls} value={colour} onChange={(e) => setColour(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.year')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={vyear} onChange={(e) => setVYear(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.fuel')}</label><input className={inputCls} value={fuel} onChange={(e) => setFuel(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.engineCc')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={engineCc} onChange={(e) => setEngineCc(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.vin')}</label>
          <input className={inputCls} value={vin} onChange={(e) => setVin(e.target.value)} autoCapitalize="characters" />
          {lookupKeyFor(vehicleLookupProvider) === 'vin' && (
            <button type="button" disabled={lookBusy || busy || !isPlausibleVin(vin)} onClick={vinLookup} data-testid="veh-lookup-vin"
              className="mt-1.5 text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline">
              {lookBusy ? t('detailsEdit.dvsaBusy') : t('detailsEdit.dvsaButton')}
            </button>
          )}
        </div>
        <div><label className={labelCls}>{t('field.mileage')}</label><input className={inputCls} type="number" inputMode="numeric" min="0" value={mileageIn} onChange={(e) => setMileageIn(e.target.value)} /></div>
        {(motShow.motExpiry || motShow.lastMotMileage != null) && (
          <div className="sm:col-span-2 text-xs text-muted">
            {motShow.motExpiry && <span>{t('field.motExpiry')}: <span className="text-ink">{motShow.motExpiry}</span></span>}
            {motShow.lastMotMileage != null && <span className="ml-3">{t('field.lastMotMileage')}: <span className="text-ink">{motShow.lastMotMileage}{motShow.lastMotDate ? ` · ${motShow.lastMotDate}` : ''}</span></span>}
          </div>
        )}
        <div><label className={labelCls}>{t('field.customer')}</label><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className={labelCls}>{t('field.phone')}</label><input className={inputCls} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="cust-phone" />
          {phoneWarn(phone) && <p className="text-[11px] text-warn mt-1">{t('field.phoneWarn')}</p>}
          {/* The DERIVED dialable form, shown so staff can see at a glance whether this number can
              actually be texted. Absent = we could not resolve it — stated, never hidden. */}
          {owner.phone && (
            <p className="text-[11px] text-muted mt-1" data-testid="cust-phone-e164">
              {owner.phoneE164 ? `${t('field.phoneDialable')}: +${owner.phoneE164}` : t('field.phoneNotDialable')}
            </p>
          )}
        </div>
        <div><label className={labelCls}>{t('field.email')}</label><input className={inputCls} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className={labelCls}>{t('field.address')}</label><textarea className={`${inputCls} resize-y`} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
        {/* ── ON ACCOUNT ─────────────────────────────────────────────────────────────────────────
            Blank is the answer for almost everyone: a garage does not release a car until the bill
            is paid, so retail work has no terms and cannot be overdue. Filling this in is the whole
            act of putting a customer on account — there is no separate switch to disagree with. */}
        <div>
          <label className={labelCls}>{t('field.accountTerms')}</label>
          <input className={inputCls} type="number" inputMode="numeric" min="1" max="180" placeholder={t('field.accountTermsPh')}
            value={termsDays} onChange={(e) => setTermsDays(e.target.value)} data-testid="cust-terms" />
          <p className="text-[11px] text-muted mt-1">{t('field.accountTermsHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('field.accountName')}</label>
          <input className={inputCls} value={accountName} onChange={(e) => setAccountName(e.target.value)} data-testid="cust-account-name" />
        </div>
        {/* CONTACT PREFERENCES — the garage is controller of this consent, so it is edited here on
            the customer's own record. Ticking a box records a REFUSAL (true); leaving it clear
            records nothing at all, so an untouched customer stays "no record" rather than being
            silently marked as consenting. */}
        <div className="sm:col-span-2">
          <div className={labelCls}>{t('field.contactPrefs')}</div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-ink">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={smsOptOut === true} onChange={(e) => setSmsOptOut(e.target.checked ? true : null)} data-testid="optout-sms" />
              {t('field.optOutSms')}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={emailOptOut === true} onChange={(e) => setEmailOptOut(e.target.checked ? true : null)} data-testid="optout-email" />
              {t('field.optOutEmail')}
            </label>
          </div>
          <p className="text-[11px] text-muted mt-1">{t('field.optOutHint')}</p>
        </div>
      </div>
      {msg && <div className={`mt-3 rounded-lg p-2 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
      {/* ── TWO ACTIONS, ONE ROW, DELIBERATELY UNALIKE ─────────────────────────────────────────
          The stage transition used to live at the very bottom of the tab, below Messages, Flags and
          Garage notes — a long scroll from the fields it is a judgement about. It belongs here.
          But side by side they must not look the same: Save is routine and pressed constantly,
          Mark complete moves the card's spine and is audited. Save keeps the filled accent and the
          RIGHTMOST position (the default place a thumb lands, last in the stack on mobile); the
          stage action is outlined, in the completion colour, and sits to its left. */}
      <div className="flex flex-col sm:flex-row sm:justify-end sm:items-center gap-2 mt-4">
        {stageAction}
        <button disabled={busy} onClick={() => submit(false)} data-testid="details-save"
          className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
          {busy ? t('detailsEdit.saving') : t('detailsEdit.save')}
        </button>
      </div>
    </div>
  );
}
