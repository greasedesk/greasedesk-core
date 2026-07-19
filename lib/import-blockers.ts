/**
 * File: lib/import-blockers.ts
 * THE one place that decides why a staged line is still outstanding, and says so in words.
 *
 * A bare count ("Lines needing a decision: 1") makes the reader hunt for the blocking field. Every
 * surface that reports outstanding work — step 2, step 5, and the commit refusal — reads this, so
 * they can never disagree about what is wrong or how many things are.
 *
 * WHICH FIELD SATISFIES A LINE depends on what the line IS:
 *   labour            → LABOUR HOURS. Parts cost is meaningless on a labour line, so demanding one
 *                       was the wrong gate; entering hours is the decision.
 *   part/misc/fixed   → PARTS COST (or a catalogue item, which supplies one).
 *   split parent      → its CHILDREN: they must exist, balance to the penny, and each be decided.
 *                       The parent is costed THROUGH them and is never asked for a cost itself.
 *   adjustment        → nothing; a credit costs 0.00 by definition.
 */
import { balanceSplit } from '@/lib/import-split';

export type StagedLineLike = {
  id: string;
  description: string;
  qty: any;
  unit_price: any;
  amount: any;
  kind: string | null;
  parent_line_id: string | null;
  catalogue_item_id: string | null;
  parts_cost: any;
  labour_hours: any;
  cost_basis: string | null;
  is_adjustment: boolean;
};

export type Blocker = { lineId: string; description: string; reason: string };

const isLabour = (l: StagedLineLike) =>
  l.kind === 'labour' || /^labou?r\b/i.test(l.description);

/** Is this individual line decided? (Not applied to split parents — see below.) */
function lineDecided(l: StagedLineLike): boolean {
  if (l.is_adjustment) return true;
  if (isLabour(l)) return l.labour_hours != null;
  return l.parts_cost != null || l.catalogue_item_id != null || l.cost_basis != null;
}

function missingReason(l: StagedLineLike): string {
  if (isLabour(l)) return 'labour hours missing';
  return 'no parts cost';
}

/**
 * Every reason this invoice cannot yet be committed, one per outstanding line.
 * `unsavedSplitFor` is supplied by the WIZARD only: a split being typed exists in the browser and
 * not in the database, so the residual can read "balanced" on screen while the parent is still
 * uncosted. That confusion is common enough to name in those words rather than leave inferable.
 */
export function blockingReasons(
  lines: StagedLineLike[],
  unsavedSplitFor?: string | null,
): Blocker[] {
  const childrenOf = new Map<string, StagedLineLike[]>();
  for (const l of lines) {
    if (!l.parent_line_id) continue;
    childrenOf.set(l.parent_line_id, [...(childrenOf.get(l.parent_line_id) ?? []), l]);
  }

  const out: Blocker[] = [];
  for (const l of lines) {
    if (l.parent_line_id) continue; // children are judged with their parent
    if (l.is_adjustment) continue;

    const kids = childrenOf.get(l.id) ?? [];

    if (kids.length) {
      const bal = balanceSplit(Number(l.amount), kids.map((k) => ({
        description: k.description, qty: Number(k.qty), unitPrice: Number(k.unit_price),
      })));
      if (!bal.ok) {
        out.push({
          lineId: l.id, description: l.description,
          reason: `split does not balance — children total £${(bal.childrenPennies / 100).toFixed(2)} against the printed £${(bal.parentPennies / 100).toFixed(2)}`,
        });
        continue;
      }
      const undecidedKids = kids.filter((k) => !lineDecided(k));
      for (const k of undecidedKids) {
        out.push({ lineId: k.id, description: `${l.description} → ${k.description}`, reason: missingReason(k) });
      }
      continue;
    }

    // No saved children. If the operator has the split editor open, say THAT — the on-screen
    // residual may read "balanced" while nothing has been persisted.
    if (unsavedSplitFor === l.id) {
      out.push({
        lineId: l.id, description: l.description,
        reason: 'split not saved — the lines you have typed do not exist yet; press Save split',
      });
      continue;
    }

    if (!lineDecided(l)) {
      out.push({ lineId: l.id, description: l.description, reason: missingReason(l) });
    }
  }
  return out;
}
