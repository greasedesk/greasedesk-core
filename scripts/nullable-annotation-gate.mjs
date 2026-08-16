/**
 * File: scripts/nullable-annotation-gate.mjs
 * A NEW nullable column must say what a null MEANS. The old ones are grandfathered by a ratchet.
 *
 * ── WHY A POINT-OF-CREATION RULE AND NOT AN AUDIT ───────────────────────────────────────────────
 * Three nullable columns were fixed in one day where the null could only mean "a caller forgot":
 * Payment.site_id (which dropped £2,485.43 from a real August), NotificationLog.group_id (which
 * silently disabled the demo block, the opt-out check and the SMS allowance) and
 * JobCardPhoto.group_id (which would have let an object survive a purge that reported success).
 * All three were found BY ACCIDENT — one because a revenue query happened to scope on it.
 *
 * A schema-wide sweep was measured and REJECTED. 386 nullable columns, 66 never null in live data,
 * and the best automated discriminator produced 29 candidates of which at least two are provably
 * wrong: Invoice.invoice_number is null before issue, and JobCardPhoto.media_type NULL *means*
 * photo. There are three categories — deliberate, temporal, forgotten — and the first two are
 * indistinguishable from the third by data alone, because all three present as "never null so far".
 * A scanner producing 29 candidates with two known-wrong would be muted inside a month.
 *
 * So the rule sits where the answer is still known: at the moment the column is written.
 *
 * ── THE RATCHET ─────────────────────────────────────────────────────────────────────────────────
 * UNANNOTATED_CEILING pins a DIRECTION. The existing unexplained columns cost nothing and are
 * not a backlog anybody must clear. A NEW nullable column with no explanation pushes the count up
 * and goes red, naming itself. Annotating one lets the ceiling drop in the same commit. Same shape
 * as INLINE_GUARD_CEILING, and set to the ACTUAL count — a ceiling with slack silently permits the
 * next few.
 *
 * ── THE HONEST WEAKNESS ─────────────────────────────────────────────────────────────────────────
 * "Annotated" means a comment within four lines mentions null. `// nullable` satisfies it and says
 * nothing. That is deliberate: it matches the 280 baseline actually measured, and tightening it
 * later would reclassify the 95 that already pass. The gate puts the QUESTION in front of the
 * author; review is what makes the answer good. No scanner can do the second part.
 */
import './_gate-preflight.mjs';
import { readFileSync } from 'node:fs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const SCALARS = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Float', 'BigInt', 'Bytes']);

/**
 * PURE: schema text → the nullable scalar columns with no explanation of their null.
 * Nullable RELATION fields are skipped — `payment_method PaymentMethod?` is not a column; its FK
 * scalar `payment_method_id String?` is, and that one is counted.
 */
export function unannotatedNullables(schema) {
  const declared = new Set([...schema.matchAll(/^(?:model|enum) (\w+) \{/gm)].map((m) => m[1]));
  const found = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [model, body] = [m[1], m[2]];
    const lines = body.split('\n');
    lines.forEach((l, i) => {
      const f = /^\s*(\w+)\s+(\w+)\?(\s|$)/.exec(l);
      if (!f) return;
      const [, field, type] = f;
      if (!SCALARS.has(type) && declared.has(type)) return; // a nullable relation, not a column
      // The trailing comment on the line itself, plus the comment block immediately above it.
      const ctx = lines.slice(Math.max(0, i - 4), i + 1).join(' ');
      if (!/\bnull\b/i.test(ctx)) found.push(`${model}.${field}`);
    });
  }
  return found;
}

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const unannotated = unannotatedNullables(schema);

// ── THE RATCHET ───────────────────────────────────────────────────────────────────────────────
// Lower this in the same commit that annotates a column. It must never be raised: raising it is
// how "we'll come back to it" becomes the permanent state.
// 280, not the 286 first quoted: that number came from a throwaway probe with a looser
// relation-exclusion rule. The parser above is the authority, and the ceiling pins what it
// actually counts — a ceiling with six of slack silently permits the next six.
const UNANNOTATED_CEILING = 278;

console.log(`\n— nullable columns with no explanation: ${unannotated.length} (ceiling ${UNANNOTATED_CEILING}) —`);
const over = unannotated.length - UNANNOTATED_CEILING;
check('no NEW unexplained nullable column', over <= 0,
  over <= 0
    ? (over === 0 ? 'at the ceiling — annotate one and lower it' : `${-over} below; lower the ceiling to ${unannotated.length} in this commit`)
    : `${over} more than the ceiling. Say what a null MEANS on the new column(s), in its doc comment:\n` +
      `    deliberate — null is a value ("NULL = the platform default")\n` +
      `    temporal   — null is an earlier state ("NULL until issue")\n` +
      `    forgotten  — then it should not be nullable at all\n` +
      `  Candidates (the list is unordered; diff schema.prisma to find yours):\n    ${unannotated.slice(0, 40).join('\n    ')}`);

// ── THE PREDICATE BITES ───────────────────────────────────────────────────────────────────────
// A scanner that matches nothing is indistinguishable from one that matches nothing REAL.
console.log('\n— proven on synthetic schemas —');
const BARE = 'model X {\n  id String @id\n  thing String?\n}\n';
const INLINE = 'model X {\n  id String @id\n  thing String? // NULL = not yet quoted\n}\n';
const ABOVE = 'model X {\n  id String @id\n  /// NULL means the platform default.\n  thing String?\n}\n';
const RELATION = 'model X {\n  id String @id\n  other Other?\n}\nmodel Other {\n  id String @id\n}\n';
const NOTNULL = 'model X {\n  id String @id\n  thing String\n}\n';
check('an unexplained nullable column is FLAGGED', unannotatedNullables(BARE).join() === 'X.thing');
check('a trailing comment explaining the null passes', unannotatedNullables(INLINE).length === 0);
check('a doc comment above it passes', unannotatedNullables(ABOVE).length === 0);
check('a nullable RELATION is not a column', unannotatedNullables(RELATION).length === 0,
  'the FK scalar beside it is what gets counted');
check('a NON-nullable column is not counted', unannotatedNullables(NOTNULL).length === 0,
  'the discriminator — otherwise this counts the whole schema');
// And the three fixed today must not reappear: they are NOT NULL now, so they cannot be in the list.
for (const c of ['Payment.site_id', 'JobCardPhoto.group_id']) {
  check(`${c} is not in the population (it is NOT NULL now)`, !unannotated.includes(c));
}
check('NotificationLog.group_id IS annotated, not merely absent', !unannotated.includes('NotificationLog.group_id'),
  'it is legitimately nullable and paired to a CHECK — the right end state, and it says so');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
