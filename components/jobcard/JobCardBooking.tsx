/**
 * File: components/jobcard/JobCardBooking.tsx
 * Schedule a job card onto the diary FROM the card. Writes the SAME storage the diary reads
 * (JobCard.resource_id/start_at/end_at) via the SAME endpoint (/api/diary) and the SAME
 * double-booking guard — one object, two views. Blank = unscheduled (not on the diary).
 * Datetime construction mirrors the diary exactly (naive-UTC) so bookings align.
 * Light theme/tokens, i18n-native, mobile-first. Manager/admin only (canManage); else read-only.
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';

type Resource = { id: string; name: string };
export type CardBooking = { resourceId: string; startAt: string; endAt: string; heldOnLift: boolean } | null;

type Props = {
  jobCardId: string;
  canManage: boolean;
  resources: Resource[];
  booking: CardBooking;
};

const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelCls = 'block text-xs text-muted mb-1';

const datePart = (iso: string) => iso.slice(0, 10);
const timePart = (iso: string) => iso.slice(11, 16);
const buildISO = (date: string, time: string) => `${date}T${time}:00.000Z`;
const prettyDT = (iso: string) => `${datePart(iso)} ${timePart(iso)}`;

export default function JobCardBooking({ jobCardId, canManage, resources, booking }: Props) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  const [current, setCurrent] = useState<CardBooking>(booking);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Form fields, seeded from the current booking (if any).
  const [liftId, setLiftId] = useState(booking?.resourceId ?? '');
  const [startDate, setStartDate] = useState(booking ? datePart(booking.startAt) : '');
  const [startTime, setStartTime] = useState(booking ? timePart(booking.startAt) : '09:00');
  const [endDate, setEndDate] = useState(booking ? datePart(booking.endAt) : '');
  const [endTime, setEndTime] = useState(booking ? timePart(booking.endAt) : '11:00');
  const [held, setHeld] = useState(!!booking?.heldOnLift);

  useEffect(() => { setCurrent(booking); }, [booking?.resourceId, booking?.startAt, booking?.endAt, booking?.heldOnLift]);

  const resourceName = (id: string) => resources.find((r) => r.id === id)?.name ?? id;

  async function book() {
    if (!liftId || !startDate || !startTime || !endDate || !endTime) { setMsg({ text: t('booking.needLiftAndTimes'), ok: false }); return; }
    const startAt = buildISO(startDate, startTime);
    const endAt = buildISO(endDate, endTime);
    if (Date.parse(endAt) <= Date.parse(startAt)) { setMsg({ text: t('booking.endAfterStart'), ok: false }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/diary', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, resourceId: liftId, startAt, endAt, heldOnLift: held }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('booking.error'), ok: false }); setBusy(false); return; }
      setCurrent({ resourceId: liftId, startAt, endAt, heldOnLift: held });
      setMsg({ text: t('booking.saved'), ok: true });
      router.replace(router.asPath);
    } catch {
      setMsg({ text: t('booking.error'), ok: false });
    }
    setBusy(false);
  }

  async function unbook() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/diary?jobCardId=${jobCardId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('booking.error'), ok: false }); setBusy(false); return; }
      setCurrent(null); setLiftId(''); setStartDate(''); setEndDate(''); setHeld(false);
      setMsg({ text: t('booking.removed'), ok: true });
      router.replace(router.asPath);
    } catch {
      setMsg({ text: t('booking.error'), ok: false });
    }
    setBusy(false);
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5 mb-5">
      <h2 className="text-lg font-semibold text-ink mb-1">{t('booking.title')}</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

      {current ? (
        <div className="text-sm text-ink space-y-1">
          <div><span className="text-muted">{t('booking.booked')}: </span>{resourceName(current.resourceId)} · {prettyDT(current.startAt)} – {prettyDT(current.endAt)}</div>
          {current.heldOnLift && <div><span className="text-xs px-2 py-0.5 rounded-full bg-warn-soft text-warn">{t('booking.heldOnLift')}</span></div>}
        </div>
      ) : (
        <p className="text-muted text-sm">{t('booking.unscheduled')}</p>
      )}

      {!canManage ? (
        <p className="text-warn text-sm mt-3">{t('booking.readOnly')}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label className={labelCls}>{t('booking.lift')}</label>
            <select className={inputCls} value={liftId} onChange={(e) => setLiftId(e.target.value)}>
              <option value="">{t('booking.selectLift')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t('booking.start')}</label>
              <div className="flex gap-2">
                <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <input type="time" className={inputCls} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('booking.end')}</label>
              <div className="flex gap-2">
                <input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                <input type="time" className={inputCls} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="w-5 h-5" checked={held} onChange={(e) => setHeld(e.target.checked)} />
            {t('booking.heldOnLift')}
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <button onClick={book} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 w-full sm:w-auto">
              {busy ? t('booking.booking') : current ? t('booking.rebook') : t('booking.book')}
            </button>
            {current && (
              <button onClick={unbook} disabled={busy} className="bg-danger-soft text-danger font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 w-full sm:w-auto">
                {t('booking.unbook')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
