/**
 * File: lib/import-split.ts
 * THE split rule for bundled invoice lines, and the one place its balance is judged.
 *
 * A line like "Supply and fit 2 x front wheel bearing" @ 2 × £133.3333 = £266.67 is parts AND
 * labour in a single figure. Splitting re-expresses it as a parts line and a labour line so the job
 * card shows what the work actually was — cost against the bearing, hours against the fitting.
 *
 * HARD INVARIANT, and the reason this is a chokepoint rather than a form validation:
 *   sum(children.amount) === parent.amount, to the penny.
 * The invoice the customer holds is the truth. A split may RE-EXPRESS it and may never CHANGE it.
 * Checked when a split is saved and AGAIN at commit, because a template applied retroactively to a
 * different parent could otherwise drift (same description, different quantity).
 *
 * Amounts are compared in PENNIES as integers. Comparing rounded pounds lets two halves of a
 * third (66.665 + 66.665) look equal to 133.33 when the parent is 133.34.
 */

/**
 * AMOUNT-FIRST. The invariant is on LINE TOTALS, so the line total is what the operator supplies
 * and the unit price is derived from it. Collecting a unit price instead forced the total to be
 * reverse-engineered — splitting a parent of 2 × £133.3333 = £266.67 meant typing £58.334, a
 * per-unit figure that appears on no invoice. Worse, it is not always solvable: a parent of £100.00
 * at qty 3 has NO 4dp unit price that lands on 10000 pennies, so the split was impossible rather
 * than merely awkward.
 *
 * `amount` is authoritative. `unitPrice` is optional and kept only so LineSplitTemplate rows
 * written before this change (qty + unitPrice, no amount) still read — see childAmountPennies.
 */
export type SplitChildInput = {
  description: string;
  qty: number;
  amount?: number;      // the child's LINE TOTAL — authoritative
  unitPrice?: number;   // legacy/derived; never the source of truth when amount is present
  kind?: string | null;
  catalogueItemId?: string | null;
  partsCost?: number | null;
  labourHours?: number | null;
};

/**
 * THE null-normaliser for operator-supplied numbers crossing the API boundary.
 *
 * Text inputs yield '' when untouched, and `?? null` does not catch '' — it only catches null and
 * undefined. An empty string therefore reached Prisma as a Decimal value and threw
 * PrismaClientValidationError inside the transaction, surfacing as a bare 500 with no message.
 * Unknown is NULL (the honest-null rule: unknown cost ≠ £0), so '', '   ' and non-numeric all
 * become null rather than zero.
 */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type SplitBalance = {
  ok: boolean;
  parentPennies: number;
  childrenPennies: number;
  residualPennies: number; // parent − children; 0 when balanced
  perChildPennies: number[];
};

/**
 * A child's own amount in pennies, rounded ONCE, the same way the parser rounds a printed line.
 *
 * Reads the STORED amount when there is one. Falling back to qty × unitPrice is for
 * LineSplitTemplate rows written before amounts existed: zero such rows exist today, but a template
 * is long-lived and a reader that assumed the new shape would fail on an old one.
 */
export const childAmountPennies = (c: SplitChildInput): number => {
  if (c.amount != null) return Math.round(Number(c.amount) * 100);
  return Math.round(Number(c.qty ?? 0) * Number(c.unitPrice ?? 0) * 100);
};

/**
 * The per-unit figure to REPORT, derived from the line total. Held at 4dp, matching
 * StagedLine.unit_price — which is how Xero prints 133.3333 in the first place. Derived, never
 * typed: 2 for £116.67 reports £58.335/unit and the line total stays exactly £116.67.
 */
export const childUnitPrice = (c: SplitChildInput): number => {
  const qty = Number(c.qty ?? 0);
  if (c.amount == null) return Number(c.unitPrice ?? 0);
  if (!qty) return 0; // qty 0 has no meaningful per-unit price; the amount still governs
  return Math.round((Number(c.amount) / qty) * 10000) / 10000;
};

export function balanceSplit(parentAmount: number, children: SplitChildInput[]): SplitBalance {
  const parentPennies = Math.round(parentAmount * 100);
  const perChildPennies = children.map(childAmountPennies);
  const childrenPennies = perChildPennies.reduce((a, b) => a + b, 0);
  const residualPennies = parentPennies - childrenPennies;
  return {
    ok: children.length >= 2 && residualPennies === 0,
    parentPennies,
    childrenPennies,
    residualPennies,
    perChildPennies,
  };
}

/** Human-readable refusal, so the API and the UI say the same thing. */
export function describeImbalance(b: SplitBalance): string | null {
  if (b.ok) return null;
  if (b.perChildPennies.length < 2) return 'A split needs at least two lines.';
  const sign = b.residualPennies > 0 ? 'short of' : 'over';
  return `Split does not balance: children total £${(b.childrenPennies / 100).toFixed(2)} against the printed £${(b.parentPennies / 100).toFixed(2)} — £${(Math.abs(b.residualPennies) / 100).toFixed(2)} ${sign} the line.`;
}

/**
 * The amount that makes child `index` close the split exactly — "balance the remainder".
 * With amounts as the input this always exists, which is what makes an unsplittable parent
 * impossible rather than occasional: type the parts child, and the labour child takes the rest by
 * construction. Returns pounds, already at 2dp because it is built from whole pennies.
 */
export function remainderFor(
  parentAmount: number,
  children: SplitChildInput[],
  index: number,
): number {
  const parentPennies = Math.round(parentAmount * 100);
  const others = children.reduce(
    (a, c, i) => a + (i === index ? 0 : childAmountPennies(c)),
    0,
  );
  return (parentPennies - others) / 100;
}

/** Validate every split on an invoice. Used by the commit gate. */
export function unbalancedSplits(
  lines: Array<{ id: string; description: string; amount: any; parent_line_id: string | null; qty: any; unit_price: any }>,
): Array<{ id: string; description: string; message: string }> {
  const byParent = new Map<string, typeof lines>();
  for (const l of lines) {
    if (!l.parent_line_id) continue;
    byParent.set(l.parent_line_id, [...(byParent.get(l.parent_line_id) ?? []), l]);
  }
  const out: Array<{ id: string; description: string; message: string }> = [];
  for (const [parentId, kids] of byParent) {
    const parent = lines.find((l) => l.id === parentId);
    if (!parent) continue;
    // Stored children carry their own amount — read it rather than recomputing from qty × price,
    // which is exactly the derivation this chokepoint exists to stop duplicating.
    const b = balanceSplit(Number(parent.amount), kids.map((k) => ({
      description: k.description, qty: Number(k.qty), amount: Number(k.amount),
    })));
    const msg = describeImbalance(b);
    if (msg) out.push({ id: parentId, description: parent.description, message: msg });
  }
  return out;
}
