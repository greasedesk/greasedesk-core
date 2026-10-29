/**
 * File: components/billing/PlanChooser.tsx
 * THE ONE RENDERER for the monthly/yearly choice, used by the onboarding checkout step and by
 * Settings → Licence.
 *
 * There is one resolver (lib/plan-choice) and there is one renderer, for the same reason: the
 * defect this slice is repairing was a price that existed in the libraries and nowhere on a
 * screen. Two copies of this markup would be two places for the offer case to be forgotten, and
 * the offer case is the one that mis-sells if it is.
 *
 * ── A TOGGLE, NOT TWO CARDS, AND YEARLY IS THE ONE SHOWING (owner, 2026-10-29) ─────────────────
 * The earlier version stacked both plans as cards with monthly pre-selected. This one puts the
 * two intervals side by side and opens on Yearly, with the saving stated as a percentage on the
 * tab itself — the garage sees the better price first and the comparison is a single glance
 * rather than two paragraphs. The default lives in the PAGES, not here: the trial-switch block on
 * the licences screen opens on yearly too, but it has a current plan to compare against and this
 * component must not assume one.
 *
 * ── HEADLINE IS A COMPARISON, THE CHARGE SENTENCE IS THE TRUTH ─────────────────────────────────
 * Yearly's headline is its monthly EQUIVALENT, which is the only way "£750 a year" and "£75 a
 * month" can be read against each other. Nothing bills monthly on the yearly plan, so the charge
 * sentence beneath — the date and the exact amount, for every location — stays prominent and
 * stays the last thing read before the button.
 *
 * Every figure arrives already resolved and formatted. This component does no arithmetic and
 * holds no price — give it a PlanChoice or give it nothing.
 */
import type { PlanChoice } from '@/lib/plan-choice';

const TAB = 'flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium cursor-pointer transition-colors';

export default function PlanChooser({
  choice, value, onChange, disabled = false,
}: {
  choice: PlanChoice;
  value: 'monthly' | 'annual';
  onChange: (v: 'monthly' | 'annual') => void;
  disabled?: boolean;
}) {
  const opt = value === 'annual' ? choice.annual : choice.monthly;
  const annual = value === 'annual';

  return (
    <fieldset data-testid="plan-choice" disabled={disabled}>
      <legend className="sr-only">Choose a plan</legend>

      {/* THE TOGGLE. Real radios, visually hidden — the segmented look is styling, the keyboard
          and screen-reader behaviour stays the behaviour of a radio group. */}
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface-muted p-1" data-testid="plan-toggle">
        {(['monthly', 'annual'] as const).map((c) => {
          const selected = value === c;
          return (
            <label
              key={c}
              data-testid={`plan-toggle-${c}`}
              data-selected={selected ? 'true' : 'false'}
              className={`${TAB} ${selected ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
            >
              <input
                type="radio"
                name="plan"
                value={c}
                checked={selected}
                onChange={() => onChange(c)}
                data-testid={`plan-radio-${c}`}
                className="sr-only"
              />
              <span>{c === 'annual' ? 'Yearly' : 'Monthly'}</span>
              {/* DERIVED FROM THE SETTINGS, NEVER TYPED — see lib/plan-choice. A typed "Save 17%"
                  becomes a lie the first time anybody changes months-paid in the Engine Room. */}
              {c === 'annual' && choice.annual.savingPercentLabel && (
                <span
                  data-testid="plan-saving-pct"
                  className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${selected ? 'bg-accent/10 text-accent' : 'bg-accent/10 text-accent'}`}
                >
                  {choice.annual.savingPercentLabel}
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="mt-3 rounded-lg border border-line bg-surface p-4" data-testid={`plan-panel-${opt.choice}`}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-ink text-3xl font-semibold tracking-tight" data-testid={`plan-headline-${opt.choice}`}>
            {opt.perMonthEquivLabel}
          </span>
          <span className="text-muted text-sm">/month</span>
        </div>
        <p className="text-muted mt-0.5 text-xs">
          per location{choice.sites > 1 ? ` — ${choice.sites} locations` : ''}
        </p>

        {annual ? (
          <>
            {/* BOTH PRICES, OR IT IS A MIS-SALE. A referred garage must see the renewal figure
                beside the first-year one, on the screen where it chooses. */}
            {choice.annual.offerApplies ? (
              <p className="text-ink mt-2 text-sm" data-testid="plan-renewal-annual">
                {choice.annual.perLocationLabel} for your first year, then {choice.annual.renewalPerLocationLabel} a year.
              </p>
            ) : (
              <p className="text-ink mt-2 text-sm" data-testid="plan-billed-annual">
                Billed {choice.annual.renewalPerLocationLabel} a year.
              </p>
            )}
            {choice.annual.savingLabel && (
              <p className="text-accent mt-1 text-sm font-medium" data-testid="plan-saving-annual">
                {choice.annual.savingLabel}
              </p>
            )}
          </>
        ) : (
          <p className="text-ink mt-2 text-sm" data-testid="plan-billed-monthly">
            Billed monthly. Cancel any time.
          </p>
        )}

        {/* THE CHARGE SENTENCE. Last thing read, own rule above it, the real total — not the
            illustrative per-location figure in the headline. */}
        <p className="text-ink border-line mt-3 border-t pt-3 text-sm font-medium" data-testid={`plan-trial-${opt.choice}`}>
          {opt.trialSentence}
        </p>
      </div>
    </fieldset>
  );
}
