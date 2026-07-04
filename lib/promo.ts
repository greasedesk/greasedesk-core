/**
 * File: lib/promo.ts
 * THE one place a promotion's discount is turned into money. A promo is advertised INC-VAT (a fixed
 * "£50 off" or a "10% off"); it is APPLIED as a single negative EX-VAT part line with vatable=true, so
 * the VAT split falls out of the aggregate sum-then-multiply recompute in lib/quote-totals (the discount
 * reduces both the ex-VAT base and the VAT proportionally — a VAT-return-correct discount). Pennies
 * end-to-end. Used by the estimate apply-promo action and unit-tested for VAT correctness.
 */
export type PromoType = 'fixed' | 'percentage';
export type PromoLite = { id: string; code: string; label: string; type: PromoType; amount: number };

/**
 * The discount for a promo, in pennies (positive magnitudes). `incTotalPennies` is the estimate's
 * current INC-VAT total at apply-time (what a percentage is taken OF). `vatRatePct` is the card's rate.
 * When not VAT-registered there is no split — ex == inc.
 *   fixed:      inc = amount(£)×100
 *   percentage: inc = round(incTotal × amount%)
 *   ex        = registered ? round(inc / (1 + rate/100)) : inc
 */
export function promoDiscountPennies(
  promo: Pick<PromoLite, 'type' | 'amount'>,
  incTotalPennies: number,
  vatRatePct: number,
  vatRegistered: boolean,
): { exPennies: number; vatPennies: number; incPennies: number } {
  const amount = Number.isFinite(promo.amount) ? promo.amount : 0;
  const rawInc = promo.type === 'percentage'
    ? Math.round(Math.max(0, incTotalPennies) * amount / 100)
    : Math.round(amount * 100);
  const incPennies = Math.max(0, rawInc);
  const exPennies = vatRegistered ? Math.round(incPennies / (1 + (vatRatePct || 0) / 100)) : incPennies;
  return { exPennies, vatPennies: incPennies - exPennies, incPennies };
}

/** The discount line's customer-facing label: "CODE — Label" (deduped if identical). */
export function promoLineLabel(code: string, label: string): string {
  const c = (code || '').trim(), l = (label || '').trim();
  if (c && l && c !== l) return `${c} — ${l}`;
  return l || c;
}
