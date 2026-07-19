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

export type SplitChildInput = {
  description: string;
  qty: number;
  unitPrice: number;
  kind?: string | null;
  catalogueItemId?: string | null;
  partsCost?: number | null;
  labourHours?: number | null;
};

export type SplitBalance = {
  ok: boolean;
  parentPennies: number;
  childrenPennies: number;
  residualPennies: number; // parent − children; 0 when balanced
  perChildPennies: number[];
};

/** A child's own amount, rounded ONCE, the same way the parser rounds a printed line. */
export const childAmountPennies = (c: SplitChildInput): number =>
  Math.round(c.qty * c.unitPrice * 100);

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
    const b = balanceSplit(Number(parent.amount), kids.map((k) => ({
      description: k.description, qty: Number(k.qty), unitPrice: Number(k.unit_price),
    })));
    const msg = describeImbalance(b);
    if (msg) out.push({ id: parentId, description: parent.description, message: msg });
  }
  return out;
}
