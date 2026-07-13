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
import { exFromIncPennies } from '@/lib/tax';

export type PromoType = 'fixed' | 'percentage';
export type PromoTargetLite = { id: string; title: string };
export type PromoLite = { id: string; code: string; label: string; type: PromoType; amount: number; targets: PromoTargetLite[] };

/**
 * An estimate line reduced to what the promo calc needs. exPennies = qty × unit_price (may be signed).
 * `catalogueItemId` is the origin hook (primary match); `title` is the line's heading (first line of
 * the printed text) used as the FALLBACK match for refless lines (old cards / hand-typed).
 */
export type EstLineLite = { catalogueItemId: string | null; title: string; exPennies: number; vatable: boolean };

/** A discount to add: exPennies is a POSITIVE magnitude; the caller stores it as a negative line. */
export type DiscountLine = { label: string; exPennies: number; vatable: boolean };

const round = (n: number) => Math.round(n);
const norm = (s: string) => (s || '').trim().toLowerCase();

/** The discount line's customer-facing label: "CODE — Label" (deduped if identical). */
export function promoLineLabel(code: string, label: string): string {
  const c = (code || '').trim(), l = (label || '').trim();
  if (c && l && c !== l) return `${c} — ${l}`;
  return l || c;
}

/** Join covered target names for a label: "Gold Service", "Gold Service, Silver Service", "A +2". */
function namesLabel(names: string[]): string {
  const u = Array.from(new Set(names.filter(Boolean)));
  if (u.length <= 2) return u.join(', ');
  return `${u[0]} +${u.length - 1}`;
}

/**
 * Compute the discount line(s) for a promo against the current estimate lines. FIXED £ = one whole-job
 * line. PERCENTAGE = per-targeted-line discount grouped by VAT treatment (each discount inherits its
 * target line's vatable flag — no line carries mixed VAT), collapsing to one line per VAT group. A line
 * matches a target by catalogue_item_id (primary) OR by title (fallback for refless lines). Returns []
 * when nothing applies (e.g. a % promo whose targets aren't on the job) → caller shows "no applicable
 * items". VAT falls out of the aggregate recompute in lib/quote-totals (negative vatable line).
 */
export function computePromoDiscounts(
  promo: Pick<PromoLite, 'type' | 'amount' | 'code' | 'label' | 'targets'>,
  lines: EstLineLite[],
  jobRatePct: number,
  vatRegistered: boolean,
): DiscountLine[] {
  const amount = Number.isFinite(promo.amount) ? promo.amount : 0;

  if (promo.type === 'fixed') {
    const incPennies = Math.max(0, round(amount * 100));
    // inc→ex gross-up via the lib/tax chokepoint (rateBp = pct × 100; ≤2dp rate → byte-identical
    // to round(inc / (1 + rate/100)); unregistered → inc IS ex).
    const exPennies = exFromIncPennies({ taxModel: 'vat', isRegistered: vatRegistered }, incPennies, round((jobRatePct || 0) * 100));
    return exPennies > 0 ? [{ label: promoLineLabel(promo.code, promo.label), exPennies, vatable: vatRegistered }] : [];
  }

  // Percentage: match targeted products to job lines (by id, else title); discount = amount% of ex.
  const targets = promo.targets || [];
  if (targets.length === 0) return [];
  const idSet = new Set(targets.map((t) => t.id));
  const titleMap = new Map(targets.map((t) => [norm(t.title), t.title] as const)); // norm → display title
  // Two VAT groups; sum ex + collect covered target names per group.
  const grp = { vatable: { base: 0, names: [] as string[] }, exempt: { base: 0, names: [] as string[] } };
  for (const l of lines) {
    if (l.exPennies <= 0) continue;
    const byId = l.catalogueItemId && idSet.has(l.catalogueItemId);
    const byTitle = titleMap.has(norm(l.title));
    if (!byId && !byTitle) continue;
    const name = byTitle ? (titleMap.get(norm(l.title)) as string) : l.title;
    const g = (l.vatable && vatRegistered) ? grp.vatable : grp.exempt;
    g.base += l.exPennies; g.names.push(name);
  }
  const out: DiscountLine[] = [];
  const emit = (base: number, names: string[], vatable: boolean) => {
    const disc = round(base * amount / 100);
    if (disc > 0) out.push({ label: `${promo.code} — ${amount}% off ${namesLabel(names)}`, exPennies: disc, vatable });
  };
  emit(grp.vatable.base, grp.vatable.names, true);
  emit(grp.exempt.base, grp.exempt.names, false);
  return out;
}
