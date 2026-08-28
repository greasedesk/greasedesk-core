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
  const lapsed = bare({ quote: { kind: 'expired', ageDays: 31, alsoLapsed: 0 }, quoteDays: -17 });
  const r = P.leadStack(lapsed, NOW);
  check('a lapsed quote puts the car in Hot', r.stack === 'hot', `${r.stack} — ${r.reasons.map((x) => x.kind).join(',')}`);
  check('  …under its own reason', r.reasons.some((x) => x.kind === 'quote_expired'), r.reasons.map((x) => x.kind).join(','));
  // NOT urgency 0 any more, and that is the point of this slice — see DATED_KINDS. The clock
  // BEHIND ranks the Hot stack, so a lapse of 17 days scores 18 and a fresher one sorts above it.
  check('  …ranked by how long ago it lapsed', r.urgency === 18, String(r.urgency));

  // ── 2. THE THREE THAT MUST NOT ───────────────────────────────────────────────────────────────
  // The discriminating half. Without these a reason that fired unconditionally would pass 1.
  check('no quote at all → no reason', P.leadReasons(bare(), NOW).length === 0,
    JSON.stringify(P.leadReasons(bare(), NOW)));
  check('  …and the car does not reach Hot', P.leadStack(bare(), NOW).stack !== 'hot');
  // Declined / still-live / verbal are all "quoteExpired is null" at the pipeline boundary — the
  // BOARD decides that, so the wiring is proven by source below and by the board's own numbers.
  check('the signal is the FACT, not a derivation',
    /quote\?:\s*\{ kind:/.test(prose('lib/marketing-pipeline.ts')) && /quoteDays\?: number \| null/.test(prose('lib/marketing-pipeline.ts')),
    'no sent_at, no status, no MAGIC_LINK_DAYS in the pipeline — it is handed what lapsed');

  // ── 3. THE ROW SAYS THE THING WORTH SAYING ───────────────────────────────────────────────────
  const text = (n, also = 0) =>
    P.leadReasons(bare({ quote: { kind: 'expired', ageDays: 14 + n, alsoLapsed: also }, quoteDays: -n }), NOW)
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


  // ══ QUOTES AS LEADS ════════════════════════════════════════════════════════════════════════
  // Every quote is a lead from the day it is created: all of them Warm, and an expired one Hot.
  // What shipped in fd21e6f was the Hot END of that reason mistaken for the whole of it — four
  // cars appeared and the seven live quotes behind them stayed invisible.
  console.log('\n— every quote is a lead —');
  const q = (over) => ({ ...bare(), quote: { kind: 'live', ageDays: 2, alsoLapsed: 0 }, quoteDays: 12, ...over });

  const live = P.leadStack(q({}), NOW);
  check('a live quote is a WARM lead from creation', live.stack === 'warm', `${live.stack} — ${live.reasons.map((x) => x.kind).join(',')}`);
  check('  …ranked by days to expiry', live.urgency === 13, String(live.urgency));
  const sooner = P.leadStack(q({ quoteDays: 3 }), NOW);
  check('  …so a quote nearer expiry outranks one further off', sooner.urgency < live.urgency,
    `${sooner.urgency} vs ${live.urgency}`);

  // ── VERBAL: A LEAD WITH NO CLOCK ─────────────────────────────────────────────────────────────
  // Someone asked the price, so it is a lead. Nothing was sent, so there is no expiry to reach and
  // no honest way to promote it. It ranks LAST in Warm on the constant that already says why:
  // "we do not know when, and not knowing must not jump the queue".
  const verbal = P.leadStack(q({ quote: { kind: 'verbal', ageDays: 14, alsoLapsed: 0 }, quoteDays: null }), NOW);
  check('a verbal quote is Warm', verbal.stack === 'warm', verbal.stack);
  check('  …at no-clock, so it sorts below every dated quote', verbal.urgency === P.URGENCY_NO_CLOCK,
    `${verbal.urgency} vs live ${live.urgency}`);
  check('  …and can never reach Hot on its own', P.leadStack(q({
    quote: { kind: 'verbal', ageDays: 900, alsoLapsed: 0 }, quoteDays: null }), NOW).stack === 'warm',
    'no sent_at means no expiry — promoting it would put a fabricated deadline on the board');

  // ── EXPIRED: HOT, FRESHEST LAPSE FIRST ───────────────────────────────────────────────────────
  const lapsedBy = (d) => P.leadStack(q({ quote: { kind: 'expired', ageDays: 14 + d, alsoLapsed: 0 }, quoteDays: -d }), NOW);
  check('an expired quote is Hot', lapsedBy(9).stack === 'hot', lapsedBy(9).stack);
  check('  …and the FRESHEST lapse ranks first', lapsedBy(9).urgency < lapsedBy(18).urgency,
    `9 days → ${lapsedBy(9).urgency}, 18 days → ${lapsedBy(18).urgency}`);
  // THE REVERSAL, PINNED. fd21e6f kept quote_expired out of DATED_KINDS so it scored 0 and outranked
  // every measured fault. Under this model the clock BEHIND is the ranking signal, so it is dated —
  // and a car with a failed cell now correctly outranks a stale quote.
  const deadCell = P.leadStack({ ...bare(), battery: 'dead_cell' }, NOW);
  check('a dead battery outranks a lapsed quote', deadCell.urgency < lapsedBy(9).urgency,
    `battery ${deadCell.urgency} vs quote ${lapsedBy(9).urgency}`);
  check('  …both still Hot', deadCell.stack === 'hot' && lapsedBy(9).stack === 'hot');

  // ── THE SETTINGS ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— what the garage can switch —');
  check('the switch OFF removes expired quotes', !P.leadReasons(
    q({ quote: { kind: 'expired', ageDays: 23, alsoLapsed: 0 }, quoteDays: -9, showExpiredQuotes: false }), NOW)
    .some((r) => r.kind === 'quote_expired'), 'a garage that does not chase lapsed quotes can say so');
  check('  …and leaves LIVE quotes alone', P.leadReasons(q({ showExpiredQuotes: false }), NOW)
    .some((r) => r.kind === 'quote_open'), 'the switch is about lapsed quotes, not about quoting');
  const early = P.leadStack(q({ quoteDays: 3, quoteHotDays: 3 }), NOW);
  check('a threshold of 3 promotes a quote 3 days from expiry', early.stack === 'hot', early.stack);
  check('  …and says it expires rather than that it lapsed', /expires in 3 days/.test(
    early.reasons.find((r) => r.kind === 'quote_open')?.text ?? ''),
    early.reasons.find((r) => r.kind === 'quote_open')?.text);
  check('  …while the same quote stays Warm with no threshold', P.leadStack(q({ quoteDays: 3 }), NOW).stack === 'warm');

  // ── THE FOUR SENTENCES ───────────────────────────────────────────────────────────────────────
  const say = (over) => P.leadReasons(q(over), NOW).find((r) => r.kind === 'quote_expired' || r.kind === 'quote_open')?.text ?? '';
  check('live reads as sent-and-waiting', /^Quote sent 2 days ago — no answer yet$/.test(say({})), say({}));
  check('  …verbal says nothing was sent', /^Quoted verbally 14 days ago — never sent$/.test(
    say({ quote: { kind: 'verbal', ageDays: 14, alsoLapsed: 0 }, quoteDays: null })),
    say({ quote: { kind: 'verbal', ageDays: 14, alsoLapsed: 0 }, quoteDays: null }));
  check('  …expired keeps the clause that makes it a lead', /^Quote expired 9 days ago — they never said no$/.test(
    say({ quote: { kind: 'expired', ageDays: 23, alsoLapsed: 0 }, quoteDays: -9 })),
    say({ quote: { kind: 'expired', ageDays: 23, alsoLapsed: 0 }, quoteDays: -9 }));
  const everySentence = [
    say({}),
    say({ quote: { kind: 'verbal', ageDays: 14, alsoLapsed: 0 }, quoteDays: null }),
    say({ quote: { kind: 'expired', ageDays: 23, alsoLapsed: 0 }, quoteDays: -9 }),
    P.leadReasons(q({ quoteDays: 3, quoteHotDays: 3 }), NOW).find((r) => r.kind === 'quote_open')?.text ?? '',
  ].join(' | ');
  check('  …and none of the four carries money', !/£|\d,\d{3}/.test(everySentence), everySentence);


  // ── THE KIND A CONTACT WOULD BE RECORDED AGAINST ─────────────────────────────────────────────
  // The row's reason kind is what the garage's call is filed under. One kind spanning live and
  // lapsed meant ringing about a quote sent yesterday was recorded as `quote_expired` — right
  // behaviour, false label, and the sort of wrong that survives because nothing looks broken.
  console.log('\n— what the call gets filed as —');
  const kindOf = (over) => P.leadReasons(q(over), NOW)
    .filter((r) => r.kind === 'quote_open' || r.kind === 'quote_expired').map((r) => r.kind).join(',');
  check('a LIVE quote files as quote_open', kindOf({}) === 'quote_open', kindOf({}));
  check('  …a VERBAL one too — nothing was sent, so nothing lapsed',
    kindOf({ quote: { kind: 'verbal', ageDays: 14, alsoLapsed: 0 }, quoteDays: null }) === 'quote_open',
    kindOf({ quote: { kind: 'verbal', ageDays: 14, alsoLapsed: 0 }, quoteDays: null }));
  check('  …and one promoted EARLY is still open, not expired',
    kindOf({ quoteDays: 3, quoteHotDays: 3 }) === 'quote_open', kindOf({ quoteDays: 3, quoteHotDays: 3 }));
  check('a LAPSED quote files as quote_expired',
    kindOf({ quote: { kind: 'expired', ageDays: 23, alsoLapsed: 0 }, quoteDays: -9 }) === 'quote_expired',
    kindOf({ quote: { kind: 'expired', ageDays: 23, alsoLapsed: 0 }, quoteDays: -9 }));
  check('both are DECLARED kinds, so a contact can record either',
    P.LEAD_REASON_KINDS.includes('quote_open') && P.LEAD_REASON_KINDS.includes('quote_expired'));
  // AND THE DATABASE ACCEPTS BOTH. marketing-board-gate compares the whole list against the CHECK
  // constraint; this pins the two that arrived together, because a kind the board offers and the
  // database refuses fails at the moment somebody rings the customer.
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const [{ def }] = await db.$queryRawUnsafe(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'MarketingContact_reason_check'");
    check('  …and the CHECK constraint accepts both', /'quote_open'/.test(def) && /'quote_expired'/.test(def),
      String(def).slice(0, 120));
  } finally { await db.$disconnect(); }

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
  // TOP-LEVEL READS, NOT A PER-VEHICLE INCLUDE. The danger is `quoteVersions` inside the SELECT on
  // the fleet-wide vehicle query, which would run once per car; a `quoteVersions: { none: {} }`
  // WHERE filter on a single top-level card query is the opposite of that, and a bare scan for the
  // identifier cannot tell them apart. Scope to the vehicle query's own block.
  const vehicleQuery = board.slice(board.indexOf('prisma.vehicle.findMany'), board.indexOf('prisma.vehicle.count'));
  check('  …as top-level reads, never a per-vehicle include',
    /prisma\.quoteVersion\.findMany/.test(board) && !/quoteVersions/.test(vehicleQuery),
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
