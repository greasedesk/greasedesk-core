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
 * Every figure arrives already resolved and formatted. This component does no arithmetic and
 * holds no price — give it a PlanChoice or give it nothing.
 */
import type { PlanChoice } from '@/lib/plan-choice';

export default function PlanChooser({
  choice, value, onChange, disabled = false,
}: {
  choice: PlanChoice;
  value: 'monthly' | 'annual';
  onChange: (v: 'monthly' | 'annual') => void;
  disabled?: boolean;
}) {
  return (
    <fieldset data-testid="plan-choice" disabled={disabled}>
      <legend className="sr-only">Choose a plan</legend>
      <div className="space-y-3">
        {([choice.monthly, choice.annual] as const).map((opt) => {
          const selected = value === opt.choice;
          const annual = opt.choice === 'annual';
          return (
            <label
              key={opt.choice}
              data-testid={`plan-option-${opt.choice}`}
              data-selected={selected ? 'true' : 'false'}
              className={`block cursor-pointer rounded-lg border p-4 transition-colors ${
                selected ? 'border-accent bg-surface-muted' : 'border-line bg-surface hover:border-accent/50'
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="plan"
                  value={opt.choice}
                  checked={selected}
                  onChange={() => onChange(opt.choice)}
                  data-testid={`plan-radio-${opt.choice}`}
                  className="mt-1 accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-ink font-semibold">{annual ? 'Yearly' : 'Monthly'}</span>
                    <span className="text-ink font-semibold" data-testid={`plan-price-${opt.choice}`}>
                      {opt.perLocationLabel}
                    </span>
                    <span className="text-muted text-sm">per location, {annual ? 'per year' : 'per month'}</span>
                  </div>

                  {/* The saving is DERIVED from the settings, never typed — see lib/plan-choice. */}
                  {annual && choice.annual.savingLabel && (
                    <p className="mt-1 text-xs text-accent font-medium" data-testid="plan-saving-annual">
                      {choice.annual.savingLabel}
                    </p>
                  )}

                  {/* BOTH PRICES, OR IT IS A MIS-SALE. A referred garage must see the renewal figure
                      beside the first-year one, on the screen where it chooses. */}
                  {annual && choice.annual.offerApplies && (
                    <p className="mt-1 text-xs text-muted" data-testid="plan-renewal-annual">
                      {choice.annual.totalLabel} for the first year, then {choice.annual.renewalTotalLabel} a year.
                    </p>
                  )}

                  <p className="mt-2 text-sm text-muted" data-testid={`plan-trial-${opt.choice}`}>
                    {opt.trialSentence}
                  </p>
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
