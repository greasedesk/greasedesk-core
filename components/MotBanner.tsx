/**
 * File: components/MotBanner.tsx
 *
 * THE MOT BANNER, rendered identically on the job-card form and the diary's create form. One
 * component over one predicate (lib/mot-banner): a car that is warned about on one screen and silent
 * on the other teaches a person to trust neither.
 *
 * Not on the diary BLOCK. The block is a glance at a day's work, and a row of red flags on cars that
 * are already here would be noise at the moment nobody can act on it. The banner belongs where the
 * decision is made — taking the booking, and writing the card.
 *
 * NO BANNER MUST NEVER BE READ AS "the MOT is fine". Hence three worded absences, and the one that
 * means nobody has asked carries a BUTTON: the remedy for an unasked question is to ask it, not to
 * word the silence better.
 */
import React from 'react';
import { motBanner, againstLabel, type MotBannerInput } from '@/lib/mot-banner';

type Props = {
  vehicle: MotBannerInput;
  /** The day the car is coming. The banner reads against THIS, not today, whenever it is in future. */
  bookingAt?: Date | string | null;
  /** Offered on the never-checked state only. Absent = no lookup here (read-only, or no provider). */
  onLookup?: () => void;
  lookupBusy?: boolean;
  now?: Date;
};

const TONE = {
  expired: 'bg-danger-soft border-danger text-ink',
  due_soon: 'bg-warn-soft border-warn text-ink',
  no_mot_unknown: 'bg-warn-soft border-warn text-ink',
  no_mot_probably_new: 'bg-surface border-line text-ink',
  never_checked: 'bg-surface border-line text-ink',
} as const;

export default function MotBanner({ vehicle, bookingAt, onLookup, lookupBusy, now }: Props) {
  const b = motBanner(vehicle, now ?? new Date(), bookingAt ?? null);
  if (b.kind === 'none') return null;

  const dated = b.kind === 'expired' || b.kind === 'due_soon';
  const headline =
    b.kind === 'expired' ? 'MOT HAS EXPIRED'
      : b.kind === 'due_soon' ? 'MOT EXPIRES WITHIN 4 WEEKS'
        : b.kind === 'no_mot_probably_new' ? 'No MOT on record'
          : b.kind === 'no_mot_unknown' ? 'No MOT on record'
            : 'MOT not checked';

  return (
    <div data-testid="mot-banner" data-mot-state={b.kind}
      className={`sm:col-span-2 lg:col-span-3 border rounded-xl px-4 py-3 mb-4 ${TONE[b.kind]}`}>
      <div className={`font-semibold ${b.kind === 'expired' ? 'text-danger' : b.kind === 'due_soon' || b.kind === 'no_mot_unknown' ? 'text-warn' : 'text-ink'}`}
        data-testid="mot-banner-headline">{headline}</div>
      {dated ? (
        <p className="text-sm mt-1" data-testid="mot-banner-detail">
          {b.kind === 'expired'
            ? <>Expired <span className="font-semibold">{b.expiry.toISOString().slice(0, 10)}</span> — {b.days} day{b.days === 1 ? '' : 's'} ago. It cannot legally be driven here.</>
            : <>Expires <span className="font-semibold">{b.expiry.toISOString().slice(0, 10)}</span> — in {b.days} day{b.days === 1 ? '' : 's'}.</>}
          {/* WHICH DAY THIS WAS JUDGED AGAINST. A reader who thinks a banner means "today" when it
              means "next Tuesday" is worse off than with no banner at all. */}
          {' '}<span className="text-muted" data-testid="mot-banner-against">({againstLabel(b)})</span>
        </p>
      ) : (
        <p className="text-sm mt-1" data-testid="mot-banner-detail">{b.reason}</p>
      )}
      {b.kind === 'never_checked' && onLookup && (
        <button type="button" onClick={onLookup} disabled={!!lookupBusy} data-testid="mot-banner-lookup"
          className="mt-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
          {lookupBusy ? 'Checking DVSA…' : 'Check with DVSA'}
        </button>
      )}
    </div>
  );
}
