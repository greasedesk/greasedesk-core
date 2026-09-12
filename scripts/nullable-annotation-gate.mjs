/**
 * File: scripts/nullable-annotation-gate.mjs
 * A NEW nullable column must say what a null MEANS — and the comment that says it must be ATTACHED
 * to that column, not merely near it. The old ones are grandfathered by a ratchet.
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
 *
 * So the rule sits where the answer is still known: at the moment the column is written.
 *
 * ── WHAT WENT WRONG WITH THE FIRST VERSION: PROXIMITY IS NOT ATTRIBUTION ────────────────────────
 * It asked whether the word "null" appeared in `lines.slice(i - 4, i + 1)` — the four lines above the
 * column, joined. That window reaches backwards across blank lines, across other fields' comments,
 * and across their declarations, so a comment explaining column A credited column B below it.
 *
 * Four false credits were found BY HAND-DIFFING, one at a time, over a week: Customer.userId,
 * Customer.opt_out_updated_at, NotificationLog.subject and NotificationLog.provider_message_id. One
 * of them made the count *FALL* when a column was added, which is the tell: a measurement that moves
 * when fields move is measuring the LAYOUT, not the schema.
 *
 * Corrected attribution, measured 2026-09-12, finds **50**. The four were the ones that happened to
 * be noticed. 28 of the 50 have a comment of their own that simply does not mention null; 22 have no
 * comment at all.
 *
 * ── ATTACHMENT, AND THE ONE CASE IT GETS WRONG ──────────────────────────────────────────────────
 * A comment block attaches to the NEXT declaration and is CONSUMED by it. A blank line, an
 * `@@`-attribute or another field detaches it. Nothing is credited by distance.
 *
 * That is wrong for one real pattern. Customer's four opt-out columns are explained by one block
 * above the first of them — on purpose, because the explanation is about the SET ("a customer may
 * refuse SMS and still accept email; NULL = no record"). Strict attachment would demand that block
 * be copy-pasted onto four fields: a gate asking for worse documentation than already exists.
 *
 * So a shared explanation DECLARES ITS SCOPE, by naming the fields:
 *
 *     /// THREE STATES… NULL = no record (unknown), true = opted OUT, false = explicitly opted IN.
 *     /// @nulls: sms_opt_out, email_opt_out, sms_marketing_opt_out, email_marketing_opt_out
 *
 * NAMING, never a count. `@covers: 4` would shift the moment somebody inserts a field between them —
 * the same formatting dependence in new clothes. A name that matches no field in its model is a RED,
 * not a silent no-op: a marker that can name nothing is the same blindfold as a guard for a hazard
 * that does not exist. And `@nulls:` does not itself satisfy the test — `\bnull\b` does not match
 * "nulls" — so a block must still say something about null to explain anything.
 *
 * ── THE RATCHET, AND WHY ITS NUMBER MOVED UP ONCE ───────────────────────────────────────────────
 * UNANNOTATED_CEILING pins a DIRECTION. A new unexplained nullable column pushes the count up and
 * goes red, naming itself. Annotating one lets the ceiling drop in the same commit.
 *
 * It must never be RAISED to accommodate a new column. On 2026-09-12 it moved 276 → 325 anyway, and
 * that is not an exception to the rule — it is a change of INSTRUMENT. The old number was what the
 * 4-line window counted; it was never a count of unexplained columns, because 50 of them were being
 * credited to comments belonging to other fields. A new instrument invalidates the old reading
 * entirely rather than permitting a higher one.
 *
 * To keep that from becoming an excuse, THE INSTRUMENT IS PINNED TO THE NUMBER: the parser's source
 * is hashed between the markers below, and the hash sits beside the ceiling. Any edit to the parser
 * fails this gate until the author re-pins the hash — and at that moment they must state the new
 * ceiling and record the old one here, with the reason. A ceiling can therefore move only when the
 * instrument provably changed, or when it FALLS. A silent raise stays impossible, which is what the
 * original rule protected.
 *
 * Correcting the instrument and annotating the 50 it reveals are two jobs (owner, 2026-09-12);
 * mixed together neither is attributable. This slice does the first and annotates nothing.
 *
 * ── THE HONEST WEAKNESS THAT REMAINS ────────────────────────────────────────────────────────────
 * "Explains the null" still means the attached text contains the word. `// nullable` satisfies it and
 * says nothing. That is deliberate and UNCHANGED here: zero columns in the schema are credited
 * solely by the phrase "NOT NULL" (measured 2026-09-12), so there is nothing to win by tightening
 * it, and tightening would reclassify the ~95 that already pass. The gate puts the QUESTION in front
 * of the author; review is what makes the answer good. No scanner can do the second part.
 */
import './_gate-preflight.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const SCALARS = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Float', 'BigInt', 'Bytes']);

// ── PARSER ── BEGIN (hashed — see THE RATCHET above; re-pin PARSER_HASH when you edit this) ──────
/**
 * PURE: schema text → one record per nullable scalar column, saying what explains its null and why.
 *
 * Nullable RELATION fields are skipped — `payment_method PaymentMethod?` is not a column; its FK
 * scalar `payment_method_id String?` is, and that one is counted.
 */
export function attributeNullables(schema) {
  const declared = new Set([...schema.matchAll(/^(?:model|enum) (\w+) \{/gm)].map((m) => m[1]));
  const records = [];
  const badNames = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [model, body] = [m[1], m[2]];
    const lines = body.split('\n');
    const fieldsInModel = new Set();
    for (const l of lines) { const f = /^\s*(\w+)\s+\w+\??(\s|$)/.exec(l); if (f && !/^\s*(@@|\/\/|\*|\/\*)/.test(l)) fieldsInModel.add(f[1]); }

    // PASS 1: the @nulls: declarations in this model, and the block each one came from.
    const named = new Map();                       // field name → the declaring block's text
    let block = [];
    for (const l of lines) {
      const t = l.trim();
      if (/^(\/\/|\/\*|\*)/.test(t)) { block.push(t); continue; }
      if (t !== '') {
        const decl = block.join(' ');
        const marker = /@nulls:\s*([A-Za-z0-9_,\s]+)/.exec(decl);
        if (marker) {
          for (const raw of marker[1].split(',')) {
            const name = raw.trim();
            if (!name) continue;
            if (!fieldsInModel.has(name)) badNames.push(`${model}: @nulls names "${name}", which is not a field of ${model}`);
            else named.set(name, decl);
          }
        }
      }
      block = [];
    }

    // PASS 2: attachment. A comment block belongs to the next declaration and is consumed by it.
    let pending = [];
    lines.forEach((l) => {
      const t = l.trim();
      if (/^(\/\/|\/\*|\*)/.test(t)) { pending.push(t); return; }
      // ANYTHING THAT IS NOT A FIELD DETACHES — a blank line, an @@attribute, a stray brace.
      // This was written with explicit `t === ''` and `t.startsWith('@@')` branches above it, and
      // red-proving showed removing either changed no answer: neither a blank line nor `@@index(…)`
      // matches the field pattern, so both already fell through to here. Decoration that reads as
      // two more rules. Deleted, and the clauses that assert detachment now depend on this line,
      // which is the one doing the work. (Third instance in a day of: a guard whose removal changes
      // nothing was never doing anything.)
      const f = /^\s*(\w+)\s+(\w+)(\?)?(\s|$)/.exec(l);
      if (!f) { pending = []; return; }
      const [, field, type, optional] = f;
      if (optional === '?' && (SCALARS.has(type) || !declared.has(type))) {
        const trailing = l.includes('//') ? l.slice(l.indexOf('//')) : '';
        const own = `${pending.join(' ')} ${trailing}`;
        const shared = named.get(field) ?? '';
        const explains = (s) => /\bnull\b/i.test(s);
        records.push({
          column: `${model}.${field}`,
          explainedBy: explains(own) ? 'own' : explains(shared) ? 'named' : null,
        });
      }
      pending = [];                                                    // CONSUMED by this field
    });
  }
  return { records, badNames };
}

/** The columns with no explanation of their null, attached or named. */
export function unannotatedNullables(schema) {
  return attributeNullables(schema).records.filter((r) => r.explainedBy === null).map((r) => r.column);
}
// ── PARSER ── END ───────────────────────────────────────────────────────────────────────────────

/**
 * THE INSTRUMENT THE CEILING WAS MEASURED WITH, kept so a parser change cannot quietly move the
 * number. Re-pin this after editing the parser, in the same commit that states the new ceiling and
 * records the old one in the header.
 */
const PARSER_HASH = '11a096053c4bd367';

/**
 * THE PREVIOUS INSTRUMENT, kept ONLY as the discriminator for the invariance clause below — it is
 * not used to classify anything. Without it "the parser is invariant" could pass on a fixture with
 * no teeth; showing that the OLD parser FAILS the same fixture is what proves the fixture bites and
 * the fix was necessary rather than cosmetic. If the invariance clause is ever deleted, delete this
 * with it: a reference implementation nothing compares against is dead weight.
 */
export function windowedNullables(schema) {
  const declared = new Set([...schema.matchAll(/^(?:model|enum) (\w+) \{/gm)].map((m) => m[1]));
  const found = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [model, body] = [m[1], m[2]];
    const lines = body.split('\n');
    lines.forEach((l, i) => {
      const f = /^\s*(\w+)\s+(\w+)\?(\s|$)/.exec(l);
      if (!f) return;
      const [, field, type] = f;
      if (!SCALARS.has(type) && declared.has(type)) return;
      const ctx = lines.slice(Math.max(0, i - 4), i + 1).join(' ');
      if (!/\bnull\b/i.test(ctx)) found.push(`${model}.${field}`);
    });
  }
  return found;
}

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const { records, badNames } = attributeNullables(schema);
const unannotated = records.filter((r) => r.explainedBy === null).map((r) => r.column);

// ── THE RATCHET ───────────────────────────────────────────────────────────────────────────────
// Lower this in the same commit that annotates a column. It must never be raised except with a new
// PARSER_HASH and the old number recorded in the header — see THE RATCHET there.
//
//   276  window-4-lines  (to 2026-09-12) — not a count of unexplained columns: 50 were credited to
//                        comments belonging to other fields. Read 283 on the day it was replaced.
//   325  attachment      (from 2026-09-12) — the same schema, measured by what a comment is attached
//                        to. Nothing was annotated in that slice, deliberately.
//   325  attachment      (cf6ff22b → 11a096053c4bd367, same slice) — the parser changed, the READING
//                        did not: two redundant detach branches were deleted after red-proving showed
//                        removing either changed no answer. Re-measured, not assumed: still 325. The
//                        hash forced this line to be written, which is the whole point of it.
const UNANNOTATED_CEILING = 325;

console.log(`\n— nullable columns with no explanation: ${unannotated.length} (ceiling ${UNANNOTATED_CEILING}) —`);
const over = unannotated.length - UNANNOTATED_CEILING;
check('no NEW unexplained nullable column', over <= 0,
  over <= 0
    ? (over === 0 ? 'at the ceiling — annotate one and lower it' : `${-over} below; lower the ceiling to ${unannotated.length} in this commit`)
    : `${over} more than the ceiling. Say what a null MEANS on the new column(s), in a comment ATTACHED to it:\n` +
      `    deliberate — null is a value ("NULL = the platform default")\n` +
      `    temporal   — null is an earlier state ("NULL until issue")\n` +
      `    forgotten  — then it should not be nullable at all\n` +
      `  One comment explaining several columns names them: // @nulls: a, b, c\n` +
      `  Candidates (the list is unordered; diff schema.prisma to find yours):\n    ${unannotated.slice(0, 40).join('\n    ')}`);

// NO SLACK, WHICH IS WHAT MAKES A SILENT RAISE IMPOSSIBLE. The parser hash below pins the
// INSTRUMENT; on its own it would not stop someone setting the ceiling to 400 on an unchanged
// parser, which is exactly the forbidden move. Equality stops it: the ceiling must BE the count, so
// a raise fails on the next run and annotating a column forces the ceiling down in the same commit.
// The header already said the ceiling is "set to the ACTUAL count — a ceiling with six of slack
// silently permits the next six"; this is that sentence enforced rather than stated.
check('the ceiling is exactly the count — no slack to spend', UNANNOTATED_CEILING === unannotated.length,
  UNANNOTATED_CEILING === unannotated.length
    ? `${UNANNOTATED_CEILING}, with nothing in hand`
    : `ceiling ${UNANNOTATED_CEILING}, count ${unannotated.length}. A ceiling above the count is a budget for the next few columns;\n`
      + `  set it to ${unannotated.length}. It may only be RAISED with a new PARSER_HASH and the old number recorded.`);

check('every @nulls: name matches a field in its model', badNames.length === 0,
  badNames.length ? `\n    ${badNames.join('\n    ')}` : 'a marker that names nothing explains nothing, silently');

// ── THE INSTRUMENT IS PINNED TO THE NUMBER ────────────────────────────────────────────────────
const parserSource = (/── PARSER ── BEGIN[\s\S]*?── PARSER ── END/.exec(readFileSync('scripts/nullable-annotation-gate.mjs', 'utf8')) ?? [''])[0];
const parserHash = createHash('sha256').update(parserSource).digest('hex').slice(0, 16);
check('the parser that produced this ceiling is the parser that is running', parserHash === PARSER_HASH,
  parserHash === PARSER_HASH
    ? `${parserHash} — a ceiling is only meaningful with the instrument that measured it`
    : `parser is ${parserHash}, ceiling was set with ${PARSER_HASH}.\n`
      + `  If you changed the parser: state the new ceiling, record the old one in the header with the\n`
      + `  reason, and set PARSER_HASH = '${parserHash}'. A ceiling may not move on an unchanged instrument.`);
check('  …and the hash really covers the parser', parserSource.length > 1500 && /attributeNullables/.test(parserSource),
  `${parserSource.length} chars — an empty or truncated slice would hash to a stable value and pin nothing`);

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

// ── ATTACHMENT, NOT PROXIMITY ─────────────────────────────────────────────────────────────────
console.log('\n— a comment explains the column it is attached to, and nothing else —');
const NEXT_ONE_ONLY = 'model X {\n  id String @id\n  /// NULL means the platform default.\n  a String?\n  b String?\n}\n';
check('a block explains the next column only', unannotatedNullables(NEXT_ONE_ONLY).join() === 'X.b',
  'the old window credited b as well, from four lines away');
// THE DETACHING LINE MUST SIT BETWEEN THE COMMENT AND THE COLUMN. Written first as
// comment / a / blank / b, these two passed for the wrong reason: `a` had already CONSUMED the block,
// so `b` was bare whatever the blank line did, and removing the detach logic left them green. An
// assertion has to be traceable to the behaviour it names — which is this whole gate's subject.
const ACROSS_BLANK = 'model X {\n  id String @id\n  /// NULL = no record.\n\n  b String?\n}\n';
check('a blank line detaches it', unannotatedNullables(ACROSS_BLANK).join() === 'X.b',
  'an orphaned block explains nothing — the column below it is not what it was written for');
const ACROSS_ATTR = 'model X {\n  id String @id\n  /// NULL = no record.\n  @@index([id])\n  b String?\n}\n';
check('an @@attribute detaches it', unannotatedNullables(ACROSS_ATTR).join() === 'X.b');
const OWN_SILENT = 'model X {\n  id String @id\n  created DateTime? // null until issue\n  /// VOID grain: set together, in one transaction, or not at all.\n  voided_at DateTime?\n}\n';
check('a column with its OWN comment that says nothing about null is flagged', unannotatedNullables(OWN_SILENT).join() === 'X.voided_at',
  'Invoice.voided_at exactly: its own comment exists and explains something else, so the window borrowed the line above');

console.log('\n— a shared explanation names the columns it covers —');
const NAMED = 'model X {\n  id String @id\n'
  + '  /// THREE STATES: NULL = no record (unknown), true = opted OUT, false = opted IN.\n'
  + '  /// @nulls: sms_opt_out, email_opt_out\n'
  + '  sms_opt_out Boolean?\n  email_opt_out Boolean?\n  other Boolean?\n}\n';
check('@nulls: covers every column it names, wherever they sit', unannotatedNullables(NAMED).join() === 'X.other',
  'Customer\'s four opt-out columns are explained by one block, on purpose — the explanation is about the SET');
const NAMED_BACKWARDS = 'model X {\n  id String @id\n  a Boolean?\n\n  /// NULL = no record.\n  /// @nulls: a\n  b Boolean?\n}\n';
check('  …including one declared after them', unannotatedNullables(NAMED_BACKWARDS).length === 0);
const NAMED_TYPO = 'model X {\n  id String @id\n  /// NULL = no record.\n  /// @nulls: sms_optout\n  sms_opt_out Boolean?\n}\n';
check('a name matching no field is a RED, not a silent no-op', attributeNullables(NAMED_TYPO).badNames.length === 1,
  'a marker that can name nothing is the same blindfold as a guard for a hazard that does not exist');
const MARKER_ALONE = 'model X {\n  id String @id\n  /// @nulls: a\n  a Boolean?\n}\n';
check('the marker alone does not satisfy the test', unannotatedNullables(MARKER_ALONE).join() === 'X.a',
  '\\bnull\\b does not match "nulls" — a block must still say something about the null');

// ── THE INVARIANCE CLAUSE ─────────────────────────────────────────────────────────────────────
// THE POINT OF THE WHOLE SLICE. A verdict must depend on the schema, not on the layout. The old
// parser cannot pass this, and that is the proof the fix was necessary rather than cosmetic: a
// measurement that moves when fields move was measuring the file.
console.log('\n— a verdict depends on the schema, not on where the lines sit —');
const head = 'model X {\n  id String @id\n  /// NULL means the platform default.\n  a String?\n';
const BASE = `${head}  b String?\n  c String?\n}\n`;
const INSERTED = `${head}  p String\n  q String\n  b String?\n  c String?\n}\n`;     // two unrelated NOT NULL columns
const REORDERED = `model X {\n  id String @id\n  b String?\n  c String?\n  /// NULL means the platform default.\n  a String?\n}\n`;
const verdicts = (f, s) => f(s).filter((c) => c !== 'X.p' && c !== 'X.q').sort().join(',');

check('inserting unrelated columns changes no other verdict', verdicts(unannotatedNullables, BASE) === verdicts(unannotatedNullables, INSERTED),
  `${verdicts(unannotatedNullables, BASE)}  vs  ${verdicts(unannotatedNullables, INSERTED)}`);
check('  …and the OLD parser provably could not say that', verdicts(windowedNullables, BASE) !== verdicts(windowedNullables, INSERTED),
  `window: ${verdicts(windowedNullables, BASE) || '(none)'}  vs  ${verdicts(windowedNullables, INSERTED)} — two NOT NULL columns pushed c out of its window, and c changed answer`);
check('reordering columns changes no verdict but the moved one\'s', verdicts(unannotatedNullables, BASE) === verdicts(unannotatedNullables, REORDERED),
  `${verdicts(unannotatedNullables, BASE)}  vs  ${verdicts(unannotatedNullables, REORDERED)}`);
check('  …and the OLD parser could not say that either', verdicts(windowedNullables, BASE) !== verdicts(windowedNullables, REORDERED),
  `window: ${verdicts(windowedNullables, BASE) || '(none)'}  vs  ${verdicts(windowedNullables, REORDERED)} — this is how a count FELL when a column was added`);

// ── REGRESSION: THE SEVEN REAL FALSE CREDITS ──────────────────────────────────────────────────
/**
 * WHY FOUR OF THESE ARE RECONSTRUCTIONS, SAID OUT LOUD.
 *
 * The four found by hand-diffing appear in NO committed revision of prisma/schema.prisma — checked
 * across the last 40, comparing both parsers (a false credit is "the window says explained AND
 * attachment says unexplained", which is not the same as "absent from the window's output"; the first
 * attempt at this measurement conflated the two and reported a clean miss).
 *
 * They are absent because each was caught in the WORKING COPY and fixed before the commit — moved,
 * or given its own sentence. That is the whole reason hand-diffing was the only thing that ever found
 * them: there was never an artefact to search. So their fixtures reproduce the reported SHAPE, and
 * are labelled as reconstructions rather than quoted history.
 *
 * A reconstruction that does not actually reproduce the defect would prove nothing — so every case
 * below asserts BOTH halves: attachment flags it AND the old window credited it. The first attempt at
 * the Customer.userId fixture failed exactly there, because the comment was too far away to be
 * credited even by the window.
 *
 * The last three are not reconstructions. They are live shapes from today's schema, found by
 * measuring rather than by noticing.
 */
console.log('\n— the four found by hand-diffing (shape, reconstructed), and the three found by measuring (live) —');
const REGRESSIONS = [
  ['Customer.userId (reconstructed)', 'model Customer {\n  id String @id\n'
    + '  // When any preference above last CHANGED — null = none ever has on this customer.\n  opt_out_updated_at DateTime?\n'
    + '  // +++ CUSTOMER PORTAL LINK ---\n  userId String? @unique\n}\n', 'Customer.userId'],
  ['Customer.opt_out_updated_at (reconstructed)', 'model Customer {\n  id String @id\n'
    + '  // THREE STATES: NULL = no record (unknown), true = opted OUT, false = opted IN.\n  sms_marketing_opt_out Boolean?\n'
    + '  opt_out_updated_at DateTime?\n}\n', 'Customer.opt_out_updated_at'],
  // ONE FIXTURE, TWO COLUMNS — the shape 1aef130 describes: the new column placed next to `recipient`,
  // its own comment about null crediting the two bare columns beneath it. Moving it last is what fixed
  // the live schema, and is also why the count moved in a direction nobody could predict.
  ['NotificationLog.subject (reconstructed)', 'model NotificationLog {\n  id String @id\n  recipient String\n'
    + '  // NULL unless this was a marketing email — minted only for those.\n  unsubscribe_token String?\n'
    + '  subject String? // email only\n  provider_message_id String?\n}\n', 'NotificationLog.subject'],
  ['NotificationLog.provider_message_id (reconstructed)', 'model NotificationLog {\n  id String @id\n  recipient String\n'
    + '  // NULL unless this was a marketing email — minted only for those.\n  unsubscribe_token String?\n'
    + '  subject String? // email only\n  provider_message_id String?\n}\n', 'NotificationLog.provider_message_id'],
  ['Invoice.voided_at (live)', 'model Invoice {\n  id String @id\n'
    + '  receipt_sent_at DateTime? // null on a confirmed invoice = visibly "receipt not sent"\n'
    + '  // --- VOID grain. Set together, in one transaction, or not at all.\n  voided_at DateTime?\n}\n', 'Invoice.voided_at'],
  ['Site.phone (live)', 'model Site {\n  id String @id\n'
    + '  // USPS subdivision code. NULL for non-US tenants and pre-existing rows (honest-null).\n  state_code String?\n'
    + '  phone String?\n}\n', 'Site.phone'],
  ['Customer.email_opt_out (live)', 'model Customer {\n  id String @id\n'
    + '  // THREE STATES, deliberately nullable: NULL = no record (unknown), true = opted OUT.\n'
    + '  sms_opt_out Boolean?\n  email_opt_out Boolean?\n}\n', 'Customer.email_opt_out'],
];
for (const [name, fixture, expected] of REGRESSIONS) {
  const now = unannotatedNullables(fixture);
  const then = windowedNullables(fixture);
  check(`${name} is flagged, and the old window credited it`, now.includes(expected) && !then.includes(expected),
    `attachment: ${now.join(', ') || '(none)'} · window: ${then.join(', ') || '(none)'}`);
}
// AND THE ONE THAT IS NOT A DEFECT. Customer.email_opt_out above is flagged correctly by attachment
// and is ALSO the case the @nulls: marker exists for: the block means all four, and saying so is a
// one-line edit rather than four copies of a paragraph. Not done here — annotating is the other job.
const FIXED_BY_MARKER = REGRESSIONS[6][1].replace('  sms_opt_out Boolean?', '  // @nulls: sms_opt_out, email_opt_out\n  sms_opt_out Boolean?');
check('  …and naming them in the block is what clears that one, in one line', unannotatedNullables(FIXED_BY_MARKER).length === 0,
  'the remedy the gate should be asking for — not four copies of the same paragraph');

// ── THE THREE THAT WERE MADE NOT NULL ─────────────────────────────────────────────────────────
for (const c of ['Payment.site_id', 'JobCardPhoto.group_id']) {
  check(`${c} is not in the population (it is NOT NULL now)`, !unannotated.includes(c));
}
check('NotificationLog.group_id IS annotated, not merely absent', !unannotated.includes('NotificationLog.group_id'),
  'it is legitimately nullable and paired to a CHECK — the right end state, and it says so');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
