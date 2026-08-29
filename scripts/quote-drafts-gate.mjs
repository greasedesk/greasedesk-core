// @gate-timeout: 90
/**
 * File: scripts/quote-drafts-gate.mjs
 * THE QUOTE NOBODY FINISHED, AND WHY IT WAS DELIBERATELY INVISIBLE.
 *
 * A card created by "New quote" is a DRAFT, and the Quotes tab only ever loaded cards at `quoted`.
 * That was a decision, not an oversight — pages/admin/jobcards/new.tsx argued it in its header:
 * "clicking New quote never puts an unpriced £0 row in the Quotes list". The reasoning was sound
 * and the conclusion was too strong. £0.00 is the problem; absence from the list is not the only
 * cure, and it cost more than it saved: FB04JNJ sat priced-and-unsent for sixteen days on the live
 * tenant, on no list, no board and no tile.
 *
 * ── £0.00 IS A CLAIM, NOT AN ABSENCE ────────────────────────────────────────────────────────────
 * An unpriced card has no value, and rendering one as "£0.00" says this job is worth nothing. Same
 * failure as the mileage-out box that defaulted to the arrival reading: a figure nobody entered,
 * indistinguishable from one somebody did. It shows as an em dash, and it is left OUT of the tab
 * total — a total that counts absences as zeros is how £0.00 becomes believable.
 *
 * ── THREE STATES, BECAUSE THEY ARE THREE DIFFERENT JOBS ─────────────────────────────────────────
 *   started, nothing priced  → somebody has to price it
 *   priced, never sent       → somebody has to send it
 *   quoted verbally          → a human said the price out loud and recorded that; unchanged
 * Collapsing the first two would put "needs a price" and "needs an envelope" in one bucket.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const Q = await import('../lib/quotes-list.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const row = (over = {}) => ({
  jobCardId: 'c1', quoteVersionId: null, version: null, verbal: false, booked: false,
  registration: 'ZZ00AAA', customerName: 'X', grossPennies: 0, sentAt: null, expiresAt: null,
  status: 'not_sent', cardStatus: 'draft', priced: false, createdAt: '2026-08-12T09:00:00.000Z',
  siteId: 's1', supersededNoLink: false, priceUnconfirmed: null, acceptanceProvenance: null, ...over,
});

try {
  // ── 1. THE FILTER EXISTS, AND LEADS ──────────────────────────────────────────────────────────
  check('not_sent is a quote filter', Q.QUOTE_FILTERS.includes('not_sent'), Q.QUOTE_FILTERS.join(' '));
  check('  …and it is FIRST, because it needs the most doing', Q.QUOTE_FILTERS[0] === 'not_sent',
    'the order is how much action a tab needs — accepted_booked is last for the same reason');

  // ── 2. THREE STATES, THREE SENTENCES ─────────────────────────────────────────────────────────
  check('an unpriced draft says nobody has priced it',
    Q.draftPill(row()) === 'Started — nothing priced yet', Q.draftPill(row()));
  check('a priced draft says nobody has sent it',
    Q.draftPill(row({ priced: true, grossPennies: 42_000 })) === 'Priced — never sent',
    Q.draftPill(row({ priced: true, grossPennies: 42_000 })));
  // THE DISCRIMINATING HALF: without it, one pill for both states would pass the two checks above
  // if it happened to match — and "needs a price" and "needs an envelope" are different jobs.
  check('  …and the two are not the same sentence',
    Q.draftPill(row()) !== Q.draftPill(row({ priced: true })));
  // FROM THE LIVE TENANT, not invented: FB04JNJ carries one line, "Quote for battery", qty 0 /
  // unit 0 / vat 0 — a placeholder typed while somebody went to find out the price. The first rule
  // here was `items.length > 0`, which would have called that priced and rendered £0.00 on the row.
  check('a line with no numbers on it is NOT priced',
    Q.draftPill(row({ priced: false, grossPennies: 0 })) === 'Started — nothing priced yet'
    && Q.quoteValuePennies(row({ priced: false, grossPennies: 0 })) === null,
    'a description is not a price');
  check('a verbal quote is untouched by any of this', Q.draftPill(row({ status: 'awaiting', cardStatus: 'quoted', verbal: true })) === null,
    'it already has its own badge, and a human deliberately recorded it');

  // ── 3. £0.00 IS A CLAIM ──────────────────────────────────────────────────────────────────────
  check('an unpriced draft has no value to show', Q.quoteValuePennies(row()) === null,
    'null renders as an em dash; 0 renders as £0.00, which says the job is worth nothing');
  check('  …while a priced one does', Q.quoteValuePennies(row({ priced: true, grossPennies: 42_000 })) === 42_000);
  check('the tab total EXCLUDES the unpriced', Q.quotesTotalPennies([row(), row({ priced: true, grossPennies: 42_000 })]) === 42_000,
    'a total that counts absences as zeros is how £0.00 becomes believable');
  check('  …and a tab of nothing but unpriced drafts totals nothing at all',
    Q.quotesTotalPennies([row(), row()]) === null, String(Q.quotesTotalPennies([row(), row()])));

  // ── 4. AGE, NOT A DEADLINE ───────────────────────────────────────────────────────────────────
  const NOW = new Date('2026-08-28T09:00:00.000Z');
  check('an unpriced draft is aged from when it was started',
    Q.draftAgeLabel(row(), NOW) === 'started 16 days ago', Q.draftAgeLabel(row(), NOW));
  check('  …a priced one from when it was priced', Q.draftAgeLabel(row({ priced: true }), NOW) === 'priced 16 days ago',
    Q.draftAgeLabel(row({ priced: true }), NOW));
  check('  …today is today, and one day is singular',
    Q.draftAgeLabel(row({ createdAt: NOW.toISOString() }), NOW) === 'started today'
    && Q.draftAgeLabel(row({ createdAt: '2026-08-27T09:00:00.000Z' }), NOW) === 'started 1 day ago',
    `${Q.draftAgeLabel(row({ createdAt: NOW.toISOString() }), NOW)} / ${Q.draftAgeLabel(row({ createdAt: '2026-08-27T09:00:00.000Z' }), NOW)}`);
  check('a draft carries NO expiry', row().expiresAt === null && Q.draftAgeLabel(row(), NOW).indexOf('due') === -1,
    'nothing was sent, so nothing lapses — the same rule verbal quotes already have');

  // ── 5. ONE QUERY, WIDENED ────────────────────────────────────────────────────────────────────
  const src = prose('lib/quotes-list.ts');
  check('the versionless read covers drafts as well as quoted',
    /status: \{ in: \['quoted', 'draft'\] \}/.test(src), 'widened and branched, not a second query');
  const cardQueries = [...src.matchAll(/prisma\.jobCard\.findMany/g)].length;
  check('  …and it is still ONE card query', cardQueries === 1, `${cardQueries} found`);

  // ── 6. THE HEADER THAT ARGUED THE OTHER WAY ──────────────────────────────────────────────────
  // Rewritten, not deleted: the £0 reasoning was right and is now handled, and a reader who finds
  // the old sentence would think the list is still supposed to exclude drafts.
  const nw = readFileSync('pages/admin/jobcards/new.tsx', 'utf8');
  // BANNING THE OLD SENTENCE WAS WRONG. The rewrite QUOTES it — "This used to end: ..." — which is
  // exactly how a reversal should be recorded, and a scan for the words reported that as the defect
  // it was documenting. Sixth time prose has defeated a scan of its own subject. Match the SHAPE of
  // a recorded reversal instead: the old claim marked as past, and the date it changed.
  check('new.tsx records the reversal rather than asserting the old rule',
    /used to end/.test(nw) && /28 Aug 2026/.test(nw),
    'a reader who finds the old sentence must be able to see it is no longer true');
  check('  …and says what happens instead', /Not sent yet/.test(nw),
    'the next reader needs where it goes, not just that the old rule is gone');
} catch (e) {
  const kind = e?.constructor?.name ?? typeof e;
  console.log(`\n✗ THREW: ${kind}: ${String(e?.message ?? e).slice(0, 300)}`);
  out.push('F');
}
const f = out.filter((x) => x === 'F').length;
console.log(`\n${f} failures of ${out.length}`);
process.exit(f ? 1 : 0);
