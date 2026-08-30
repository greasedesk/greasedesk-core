/**
 * File: scripts/sms-suffix-gate.mjs
 * The reply-route suffix: separated properly, worded as an instruction, and inside the budget.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * The suffix began with a bare space, so it ran into the body: a garage typing "Your car is ready
 * for collection" produced "…for collection No replies - call 0330…" — one sentence to the reader.
 *
 * ── WHY "JUST ADD A FULL STOP" IS WRONG ─────────────────────────────────────────────────────────
 * FIVE of the six templates end in a URL. A period placed straight after a link is captured by the
 * link detector in several clients, and the customer gets a 404 on a pay link. So the separator is
 * computed from how the body ENDS — terminal punctuation and URLs both take a space, everything
 * else takes ". " — and the URL case is asserted here because it is the one a plausible fix breaks.
 *
 * ── AND THE WORDING ─────────────────────────────────────────────────────────────────────────────
 * "No replies" describes our sender configuration and leaves the customer to infer the consequence.
 * "To reply, call …" tells them what to do, and is two septets cheaper.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { NOTIFICATION_TEMPLATES } = await import('../lib/notification-templates.ts');
const { smsCost, smsText } = await import('../lib/sms-text.ts');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const PHONE = '03309990020';
const D = (over = {}) => ({
  garageName: 'Marketbridge Motor Works Ltd', registration: 'AB12 CDE', total: '£1,234.56',
  number: '100003211', link: 'https://greasedesk.com/c/aBcDeFgHiJkLmNoP',
  garagePhone: PHONE, version: 3, when: 'today', customerName: 'A Customer', ...over,
});
const sms = (k, over) => NOTIFICATION_TEMPLATES[k]?.sms?.(D(over))?.text ?? '';

try {
  // ── 1. THE SEPARATOR ───────────────────────────────────────────────────────────────────────
  console.log('\n— body and suffix are separated —');
  const free = sms('free_text', { body: 'Your car is ready for collection' });
  check('an unpunctuated body gets a full stop', free.includes('collection. To reply, call'),
    free.slice(-62));
  check('and does NOT run the two together', !/collection To reply/.test(free),
    'the defect: "…for collection No replies - call…" read as one sentence');

  const punctuated = sms('free_text', { body: 'Your car is ready.' });
  check('a body that already ends in a full stop gets ONE', punctuated.includes('ready. To reply,')
    && !punctuated.includes('ready.. To reply'), punctuated.slice(-44));
  for (const [end, label] of [['Ready!', '!'], ['Ready?', '?']]) {
    const t = sms('free_text', { body: end });
    check(`a body ending in ${label} is not given a full stop`, t.includes(`${end} To reply,`), t.slice(-38));
  }

  // ── 2. THE URL CASE — the one a naive fix breaks ───────────────────────────────────────────
  console.log('\n— a period is never glued to a link —');
  for (const k of ['quote_revised', 'quote_ready', 'job_card_link', 'invoice_pay_link']) {
    const t = sms(k);
    check(`${k}: the link is followed by a space, not a full stop`,
      t.includes('aBcDeFgHiJkLmNoP To reply,') && !t.includes('aBcDeFgHiJkLmNoP. To reply'),
      'a period after a URL is captured by the link detector — the customer gets a 404 on a pay link');
  }
  // Discriminating: the separator function genuinely varies, rather than always returning a space.
  check('the check is discriminating — free text DOES get a full stop', free.includes('collection. '),
    'if every ending took a space, the URL assertions above would pass for the wrong reason');

  // ── 3. THE WORDING ─────────────────────────────────────────────────────────────────────────
  console.log('\n— an instruction, not a description —');
  const src = readFileSync('lib/notification-templates.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('no template still says "No replies"', !/No replies/.test(code),
    'it described our sender configuration and left the consequence to the reader');
  check('the check is discriminating — the comment still explains what it replaced', /No replies/.test(src));
  check('every customer-facing SMS carries the route', ['quote_revised', 'quote_ready', 'job_card_link', 'invoice_pay_link', 'free_text']
    .every((k) => sms(k, { body: 'x' }).includes(`To reply, call ${PHONE}`)));

  // ── 4. OMITTED, NOT FAKED ──────────────────────────────────────────────────────────────────
  const noPhone = sms('free_text', { body: 'Your car is ready', garagePhone: undefined });
  check('with no number on file the suffix is OMITTED entirely', !/To reply/.test(noPhone) && !/call\s*$/.test(noPhone),
    `"${noPhone}"`);
  check('and no stray separator is left behind', !/\.\s*$/.test(noPhone.replace('Your car is ready', '')),
    'an empty "call " is worse than nothing');

  // ── 5. THE BUDGET ──────────────────────────────────────────────────────────────────────────
  console.log('\n— the segment budget —');
  const cost = (t) => smsCost(smsText(t));
  for (const k of ['quote_ready', 'job_card_link', 'invoice_pay_link']) {
    const c = cost(sms(k));
    check(`${k} stays in ONE segment`, c.segments === 1, `${c.septets} septets`);
  }
  check('free text with a typical message stays in one segment',
    cost(sms('free_text', { body: 'Your car is ready for collection' })).segments === 1);
  // The new wording must not be MORE expensive than what it replaced.
  // NOTE THE SEPARATOR. The invoice body ends in a URL, so its separator is a SPACE — the first
  // version of this check substituted ". To reply, call", matched nothing, and compared the string
  // to itself: 148 vs 148, passing for no reason at all. Assert the substitution HAPPENED.
  const newText = sms('invoice_pay_link');
  const oldText = newText.replace(` To reply, call ${PHONE}`, ` No replies - call ${PHONE}`);
  check('the comparison is real — the substitution changed the string', oldText !== newText,
    'a replace that matches nothing compares a string to itself and always passes');
  const withNew = cost(newText).septets, withOld = cost(oldText).septets;
  check('the new wording is CHEAPER than the old', withNew < withOld, `${withNew} vs ${withOld} septets`);

  // ── 6. THE KNOWN OVERRUN, PINNED RATHER THAN HIDDEN ────────────────────────────────────────
  // quote_revised exceeds one segment with a long garage name — TODAY, and before this change.
  // Unlike invoice_pay_link it has no drop-the-registration fallback. Asserted so it is a recorded
  // fact rather than a surprise, and so the day someone adds a fallback this check goes red and
  // gets deleted deliberately.
  const qr = cost(sms('quote_revised'));
  check('KNOWN: quote_revised needs 2 segments with a 28-char garage name', qr.segments === 2,
    `${qr.septets} septets — pre-existing, no fallback like invoice_pay_link's. Reported, not fixed here.`);
  const qrShort = cost(sms('quote_revised', { garageName: 'Dave Motors' }));
  check('…but fits in one with a short name', qrShort.segments === 1, `${qrShort.septets} septets`);
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  process.exit(out.includes('F') ? 1 : 0);
}
