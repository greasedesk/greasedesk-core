// @gate-timeout: 120
/**
 * File: scripts/quote-lead-gate.mjs
 * THE LEAD THAT WAS SITTING IN A TAB NOBODY OPENS.
 *
 * £2,075 of quoted work lapsed on TMBS and nobody rang any of the four customers. The data was
 * right and the Quotes tab was right; nothing brought the customer back. All four cars were LOADED
 * by the board and then dropped at `if (!reasons.length) continue` — their MOTs are in 2027, they
 * have no open findings, no battery reading and no tyre reading, so they produced no reason at all.
 *
 * An expired quote is the best lead on the board: you know what they wanted, you know what it
 * costs, and they never said no. It sits beside agreed_not_booked in Hot for the same reason.
 *
 * ── THE THREE THINGS THAT MUST NOT BECOME A CALL ────────────────────────────────────────────────
 *   declined  — they answered. The whole argument for this lead is that they did not.
 *   inside 14 days — still live. Ringing is chasing, not reviving.
 *   a CLOSED CARD — AP16RGX's quote lapsed and its card is `paid`: the work was done. Telling
 *                   somebody to ring a customer about work they have already paid for is the worst
 *                   call on the board, and it is why this reuses QUOTE_CLOSED_CARD_STATUSES rather
 *                   than inventing its own idea of "still open".
 *
 * A verbal quote has no sent_at, so there is no expiry and no age — it never lapses and is not
 * this reason. Whether it belongs on the board at all is a separate decision, deliberately not
 * taken here.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const P = await import('../lib/marketing-pipeline.ts');
const Q = await import('../lib/quotes-list.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
// COMMENTS STRIPPED BEFORE ANY SOURCE SCAN. Files here EXPLAIN what they must not contain — the
// board says MAGIC_LINK_DAYS stays in one place — so a bare scan matches its own reasoning and
// reports correct code as broken. Fifth time this shape has bitten; strip prose, then match a
// call shape or an emitted key rather than a bare identifier.
const prose = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const NOW = new Date('2026-08-27T12:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86_400_000);

/** A car with nothing else going on — exactly the shape of the four on TMBS. */
const bare = (over = {}) => ({
  motBand: null, motDays: null, battery: null, lowestTreadTenths: null,
  findings: [], contact: null, serviceDueDays: null, quoteExpired: null, ...over,
});
/** NO VALUE IN THE SIGNAL — see the note on LeadSignals.quoteExpired. marketing-board-gate holds
 *  the board to carrying no money field at all, and reason.text renders unconditionally. */

try {
  // ── 1. IT REACHES HOT, AT URGENCY 0 ──────────────────────────────────────────────────────────
  const lapsed = bare({ quoteExpired: { expiredAt: day(17), alsoLapsed: 0 } });
  const r = P.leadStack(lapsed, NOW);
  check('a lapsed quote puts the car in Hot', r.stack === 'hot', `${r.stack} — ${r.reasons.map((x) => x.kind).join(',')}`);
  check('  …under its own reason', r.reasons.some((x) => x.kind === 'quote_expired'), r.reasons.map((x) => x.kind).join(','));
  check('  …at urgency 0, above every clock', r.urgency === P.URGENCY_MEASURED, String(r.urgency));

  // ── 2. THE THREE THAT MUST NOT ───────────────────────────────────────────────────────────────
  // The discriminating half. Without these a reason that fired unconditionally would pass 1.
  check('nothing lapsed → no reason at all', P.leadReasons(bare(), NOW).length === 0,
    JSON.stringify(P.leadReasons(bare(), NOW)));
  check('  …and the car does not reach Hot', P.leadStack(bare(), NOW).stack !== 'hot');
  // Declined / still-live / verbal are all "quoteExpired is null" at the pipeline boundary — the
  // BOARD decides that, so the wiring is proven by source below and by the board's own numbers.
  check('the signal is the FACT, not a derivation', /quoteExpired\?:\s*\{[^}]*expiredAt: Date/.test(prose('lib/marketing-pipeline.ts')),
    'no sent_at, no status, no MAGIC_LINK_DAYS in the pipeline — it is handed what lapsed');

  // ── 3. THE ROW SAYS THE THING WORTH SAYING ───────────────────────────────────────────────────
  const text = (n, also = 0) =>
    P.leadReasons(bare({ quoteExpired: { expiredAt: day(n), alsoLapsed: also } }), NOW)
      .find((x) => x.kind === 'quote_expired')?.text ?? '';
  // NO FIGURE IN THE SENTENCE. The value is the sharpest fact about this lead and it is
  // deliberately absent: the board carries no money field, so a figure here is the £1,214 leak
  // wearing different clothes. Asserted as an ABSENCE so nobody re-adds it without meeting this.
  check('the row carries no money', !/£|\d,\d{3}|pennies/.test(text(17)), text(17));
  check('  …and the pipeline does not reach for formatMoney',
    !/formatMoney\(/.test(prose('lib/marketing-pipeline.ts')), 'money on this board must go through financeVisibility first');
  check('the age leads', /^Quote expired 17 days ago/.test(text(17)), text(17));
  check('  …and the clause that makes it a lead', /never said no/.test(text(17)), text(17));
  // THREE-WAY, because "expired 0 days ago" is not a sentence and "1 days" is not either.
  check('today reads as today', /expired today/.test(text(0)) && !/0 days/.test(text(0)), text(0));
  check('  …one day is singular', /expired 1 day ago/.test(text(1)), text(1));
  check('several lapsed: the oldest is named and the rest counted', /1 more/.test(text(17, 1)), text(17, 1));
  check('  …and one alone says nothing about others', !/more/.test(text(17)), text(17));

  // ── 4. THE ENUM PAIR, WHICH THE DRIFT GATE ALSO GUARDS ───────────────────────────────────────
  check('quote_expired is a LeadReasonKind value', P.LEAD_REASON_KINDS.includes('quote_expired'),
    P.LEAD_REASON_KINDS.join(' '));

  const board = prose('lib/marketing-board.ts');
  check('the board asks lib/quotes-list what expired means', /deriveQuoteStatus|quoteExpiry/.test(board),
    'the board and the Quotes tab must not disagree about what lapsed');
  check('  …and does not re-add MAGIC_LINK_DAYS', !/MAGIC_LINK_DAYS/.test(board),
    'a second copy of 14 is how the two surfaces start drifting apart');
  check('  …and excludes closed cards through the shared list', /QUOTE_CLOSED_CARD_STATUSES/.test(board),
    'AP16RGX lapsed and was PAID — ringing about that is the worst call on the board');
  check('  …with ONE extra top-level query, not a per-vehicle include',
    /prisma\.quoteVersion\.findMany/.test(board) && !/quoteVersions:\s*\{/.test(board),
    'query depth is latency currency on lhr1');
  check('  …reduced to a Map keyed by vehicle', /new Map<string,[^>]*>\(\)|quoteByVehicle/.test(board));
  check('a verbal quote is not this reason', !/verbal/.test(Q.QUOTE_FILTERS.join(' ')) && true,
    'no sent_at means no expiry and no age — deliberately left off, not forgotten');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 700)}`);
  out.push('F');
}
const f = out.filter((x) => x === 'F').length;
console.log(`\n${f} failures of ${out.length}`);
process.exit(f ? 1 : 0);
