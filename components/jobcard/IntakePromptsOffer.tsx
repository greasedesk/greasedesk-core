/**
 * File: components/jobcard/IntakePromptsOffer.tsx
 * THE ONE LINE THAT TELLS A GARAGE THE FEATURE EXISTS.
 *
 * ── WHY IT IS HERE AND NOT IN SETTINGS ──────────────────────────────────────────────────────────
 * The panel that switches prompts on has always existed, in Settings → Locations. Measured
 * 2026-08-19: five real tenants had all five off and always had; the only tenant with any enabled
 * was the demo. It was never hidden — it was simply never mentioned on the screen where a garage
 * would want it. Being seen is the entire point, so it goes where the work happens.
 *
 * ── IT IS AN OFFER, NOT A NAG ───────────────────────────────────────────────────────────────────
 * Four things this deliberately is not:
 *   · NOT a warning. No amber, no icon, no exclamation. This sits on a screen a mechanic is trying
 *     to get through, and anything resembling an error costs them a beat working out whether they
 *     have done something wrong.
 *   · NOT per-item. A garage with three of five on has made a choice, and second-guessing it is
 *     exactly the shape people learn to ignore.
 *   · NOT repeatable. "No thanks" is a SITE fact, and a banner that comes back on the next device
 *     teaches people that dismissing things here does not work — a lesson that spreads to every
 *     dismissal we ever ship.
 *   · NOT a feature announcement. It leads with a fact about THEIR garage, because "nothing is
 *     being checked" is worth a mechanic's half-second and "you can enable prompts" is not.
 *
 * It names the items, because the value is in the specifics and most garages will not know a
 * walkaround video is on offer. And it names the email, because that is the actual product: not
 * five checkboxes but knowing when something got missed. Hiding the payoff behind a settings screen
 * is how this stayed invisible for as long as it did.
 */
import React, { useState } from 'react';
import Link from 'next/link';

export default function IntakePromptsOffer({ jobCardId, canEdit, onDismissed }: {
  jobCardId: string; canEdit: boolean; onDismissed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return null;

  async function dismiss() {
    setBusy(true);
    try {
      await fetch('/api/intake-items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, action: 'dismiss_offer' }),
      });
      // Hidden immediately AND recorded on the site, so it is gone here and gone everywhere.
      setGone(true);
      onDismissed();
    } finally { setBusy(false); }
  }

  return (
    <div className="mb-4 rounded-xl border border-line bg-surface-muted p-3" data-testid="intake-prompts-offer">
      <p className="text-sm text-ink">
        <strong className="font-semibold">Nothing is being checked before cars go in.</strong>{' '}
        <span className="text-muted">
          You can ask for a walkaround video, mileage and VIN, a diagnostic scan, an oil level check,
          or a note of what the car needs — and get an email when one gets missed.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <Link href="/admin/settings/locations" data-testid="intake-offer-setup"
          className="text-sm font-semibold text-accent underline">
          Set it up
        </Link>
        {canEdit && (
          <button type="button" onClick={dismiss} disabled={busy} data-testid="intake-offer-dismiss"
            className="text-sm text-muted underline disabled:opacity-50">
            {busy ? 'Saving…' : 'No thanks'}
          </button>
        )}
      </div>
    </div>
  );
}
