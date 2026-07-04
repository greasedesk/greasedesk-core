/**
 * File: lib/promo.ts
 * THE one place a promotion is turned into discount line(s). A promo is advertised INC-VAT and applied
 * as negative EX-VAT part line(s) with a per-line vatable flag, so the VAT split falls out of the
 * aggregate sum-then-multiply recompute in lib/quote-totals (each discount reduces both the ex-VAT base
 * and the VAT proportionally — VAT-return-correct). Pennies end-to-end. Unit-tested for VAT correctness.
 *
 *  - FIXED £: a whole-job discount. `amount` is £ inc-VAT → ex = round(inc / (1 + rate/100)); one line.
 *  - PERCENTAGE: targets specific products. For each job line whose catalogue_item_id is in the promo's
 *    targets, discount = amount% × that line's ex total. Grouped by the line's own vatable flag (a
 *    vatable service discounts WITH its VAT; a non-vatable MOT ex-only) → at most two lines. This is
 *    what "dissolves mixed-VAT": each targeted line keeps its own VAT treatment.
 */
export type PromoType = 'fixed' | 'percentage';
export type PromoLite = { id: string; code: string; label: string; type: PromoType; amount: number; targetIds: string[] };

/** An estimate line reduced to what the promo calc needs. exPennies = qty × unit_price (may be signed). */
export type EstLineLite = { catalogueItemId: string | null; exPennies: number; vatable: boolean };

/** A discount to add: exPennies is a POSITIVE magnitude; the caller stores it as a negative line. */
export type DiscountLine = { label: string; exPennies: number; vatable: boolean };

const round = (n: number) => Math.round(n);

/** The discount line's customer-facing label: "CODE — Label" (deduped if identical). */
export function promoLineLabel(code: string, label: string): string {
  const c = (code || '').trim(), l = (label || '').trim();
  if (c && l && c !== l) return `${c} — ${l}`;
  return l || c;
}

/**
 * Compute the discount line(s) to add for a promo. `incTotalPennies` is the estimate's current INC-VAT
 * total (fixed £ uses it only for the not-registered passthrough; the amount itself is the £). `lines`
 * are the current estimate lines (percentage matches against them). Returns [] when nothing applies
 * (e.g. a % promo whose targets aren't on the job) — the caller shows "no applicable items".
 */
export function computePromoDiscounts(
  promo: Pick<PromoLite, 'type' | 'amount' | 'code' | 'label' | 'targetIds'>,
  lines: EstLineLite[],
  jobRatePct: number,
  vatRegistered: boolean,
): DiscountLine[] {
  const label = promoLineLabel(promo.code, promo.label);
  const amount = Number.isFinite(promo.amount) ? promo.amount : 0;

  if (promo.type === 'fixed') {
    const incPennies = Math.max(0, round(amount * 100));
    const exPennies = vatRegistered ? round(incPennies / (1 + (jobRatePct || 0) / 100)) : incPennies;
    return exPennies > 0 ? [{ label, exPennies, vatable: vatRegistered }] : [];
  }

  // Percentage: match targeted products to job lines; discount = amount% of each matched line's ex.
  const targets = new Set(promo.targetIds || []);
  if (targets.size === 0) return [];
  let vatableBase = 0, nonVatBase = 0;
  for (const l of lines) {
    if (!l.catalogueItemId || !targets.has(l.catalogueItemId) || l.exPennies <= 0) continue;
    if (l.vatable && vatRegistered) vatableBase += l.exPennies; else nonVatBase += l.exPennies;
  }
  const out: DiscountLine[] = [];
  const vatableDisc = round(vatableBase * amount / 100);
  const nonVatDisc = round(nonVatBase * amount / 100);
  if (vatableDisc > 0) out.push({ label, exPennies: vatableDisc, vatable: true });
  if (nonVatDisc > 0) out.push({ label, exPennies: nonVatDisc, vatable: false });
  return out;
}
