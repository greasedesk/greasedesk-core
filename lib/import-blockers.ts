/**
 * File: lib/import-blockers.ts
 * THE one place that decides why a staged line is still outstanding, and says so in words.
 *
 * A bare count ("Lines needing a decision: 1") makes the reader hunt for the blocking field. Every
 * surface that reports outstanding work — step 2, step 5, and the commit refusal — reads this, so
 * they can never disagree about what is wrong or how many things are.
 *
 * WHICH FIELD SATISFIES A LINE depends on what the operator DECLARED the line to be (resolutionOf):
 *   catalogue         → nothing to enter; the product supplies cost and hours.
 *   labour            → LABOUR HOURS. A parts cost on a labour line is meaningless.
 *   part/misc/fixed   → PARTS COST. Hours on a parts line are meaningless.
 *   undeclared        → the declaration itself is the outstanding decision.
 *   split parent      → its CHILDREN: they must exist, balance to the penny, and each be decided.
 *                       The parent is costed THROUGH them and is never asked for a cost itself.
 *   adjustment        → nothing; a credit costs 0.00 by definition.
 *
 * SPLITTING IS NOT MANDATORY. A line resolved by catalogue product needs no split, and neither does
 * one the operator declares parts-only or labour-only. Splitting exists for the bundled line that is
 * genuinely both.
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

/**
 * HOW A LINE RESOLVES. Exactly one of three, and the operator CHOOSES it — nothing is inferred from
 * the wording. Guessing by description read "Labour to fit customer supplied intercooler pipe" as
 * labour and "Supply and fit new battery" as parts, when the second is both, and it silently
 * decided which figure the operator would be asked for.
 *
 *   catalogue — a product supplies its own cost and hours; nothing is entered here
 *   labour    — carries HOURS; a parts cost on a labour line is meaningless
 *   part      — carries a PARTS COST; hours on a parts line are meaningless
 *
 * A line that is genuinely both is not a fourth case: it is a bundle, and splitting it into a parts
 * child and a labour child is how it becomes two lines that each resolve one way.
 */
export type Resolution = 'catalogue' | 'labour' | 'part' | 'undeclared';

export function resolutionOf(l: StagedLineLike): Resolution {
  if (l.catalogue_item_id != null) return 'catalogue';
  if (l.kind === 'labour') return 'labour';
  if (l.kind === 'part' || l.kind === 'misc' || l.kind === 'fixed') return 'part';
  return 'undeclared';
}

/** Is this individual line decided? (Not applied to split parents — see below.) */
function lineDecided(l: StagedLineLike): boolean {
  if (l.is_adjustment) return true;
  switch (resolutionOf(l)) {
    case 'catalogue': return true;          // the product carries cost and hours
    case 'labour':    return l.labour_hours != null;
    case 'part':      return l.parts_cost != null;
    // UNDECLARED is not "probably parts" — it is a decision nobody has made yet, and saying so is
    // the whole point of asking explicitly.
    case 'undeclared': return false;
  }
}

function missingReason(l: StagedLineLike): string {
  switch (resolutionOf(l)) {
    case 'labour': return 'labour hours missing';
    case 'part':   return 'no parts cost';
    default:       return 'not yet declared as parts, labour or a catalogue product';
  }
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
        description: k.description, qty: Number(k.qty), amount: Number(k.amount),
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
