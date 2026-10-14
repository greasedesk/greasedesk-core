/**
 * File: scripts/quote-closure-gate.mjs
 * @gate-requires: db
 *
 * A CARD THAT HAS ENDED MUST NOT STILL SERVE A LIVE QUOTE.
 *
 * ── WHY THIS EXISTS, AND WHY IT ENUMERATES ──────────────────────────────────────────────────────
 * The same defect has shipped THREE times in one function, each time for one status at a time:
 *
 *   cancelled — three cancelled cards were still serving live quotes;
 *   no_show   — a customer who never turned up still holding a live link;
 *   declined  — MJ71ZNU, 2026-10-14: the garage said no and the customer's link stayed live until
 *               the following lunchtime, good for £2,074.06 of work that had been refused.
 *
 * Each was fixed on its own and the next one shipped anyway, because nothing held the RULE. So this
 * gate enumerates the closing statuses from the model rather than checking the three somebody
 * happened to think of: a fourth terminal status added to JOB_STATUSES fails here until it either
 * revokes or says in the gate why it does not ([[completeness-clause-naming-convention]]).
 *
 * 'declined' was a declared RevokeReason from the day the enum was written, and the customer-facing
 * copy for it (REVOKED_COPY.declined) was written too. Both sat there unreachable because one
 * caller never passed it — which is why the test is "the reason is PASSED", not "the reason exists".
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

try {
  const S = await import('../lib/jobcard-status.ts');
  const M = await import('../lib/magic-link.ts');
  const api = readFileSync('pages/api/jobcard-status.ts', 'utf8');
  const customerPage = readFileSync('pages/c/[token].tsx', 'utf8');
  const metrics = readFileSync('lib/quotes-metrics.ts', 'utf8');
  const workspace = readFileSync('components/jobcard/JobCardWorkspace.tsx', 'utf8');

  /**
   * THE CLOSING STATUSES, derived. A status CLOSES a quote when the card can no longer reach
   * `accepted` from it — which is exactly the question refuseQuoteAnswer already answers, so the
   * list cannot drift from the lifecycle it describes.
   */
  const closing = S.JOB_STATUSES.filter((st) => st !== 'accepted' && !S.findTransition(st, 'accepted'));
  console.log(`\n— the statuses a quote cannot survive: ${closing.join(', ')} —`);
  check('the list is derived from the lifecycle, not typed out', closing.length >= 3
    && closing.includes('cancelled') && closing.includes('no_show'),
    `${closing.length} of ${S.JOB_STATUSES.length} statuses close a quote`);
  /** DECLINED IS NOT IN IT, and that is correct: declined → accepted is the designed REOPEN. It
   *  closes the quote WITHOUT closing the card, which is the case the three fixes kept missing. */
  check('  …and declined is NOT among them, because a decline can be reopened',
    !closing.includes('declined') && !!S.findTransition('declined', 'accepted'),
    'declined → accepted is the reopen path; the quote still has to die');

  /**
   * EVERY CLOSING STATUS IS ACCOUNTED FOR — revoked, or exempt WITH A REASON. The first draft of
   * this gate demanded that each one revoke inside jobcard-status, which was the gate being wrong
   * rather than the code: `invoiced` is killed by lib/invoice-issue, and paid/done sit downstream
   * of it. Forcing a decision per status is the point; forcing the same mechanism is not.
   */
  const EXEMPT = {
    draft: 'no quote has been sent from a draft, so there is no link to kill',
    in_progress: 'only reachable once the offer was ANSWERED, and quote-respond refuses a second answer; the link dies when the invoice is raised',
    paid: 'downstream of invoiced, which revokes',
    done: 'downstream of invoiced, which revokes',
  };
  const invoiceSrc = readFileSync('lib/invoice-issue.ts', 'utf8');
  const revokesSomewhere = (st) =>
    new RegExp(`revokeMagicLinksForCard\\(jobCardId, '${st}'`).test(api + invoiceSrc);

  console.log('\n— every one of them is accounted for: revoked, or exempt with a reason —');
  for (const st of [...closing, 'declined']) {
    const ok = revokesSomewhere(st) || Object.prototype.hasOwnProperty.call(EXEMPT, st);
    check(`${st}: ${revokesSomewhere(st) ? 'revokes with its own reason' : EXEMPT[st] ?? 'UNACCOUNTED'}`, ok,
      ok ? '' : `nothing kills the link for '${st}', and the gate has no reason why not — a dead card still serving a live quote`);
  }
  check('  …and no exemption is claimed for a status that is not closing', (() => {
    const stale = Object.keys(EXEMPT).filter((st) => !closing.includes(st));
    return stale.length === 0;
  })(), 'an exemption outliving its status is a blindfold');
  check('  …and every reason passed is one the type allows', (() => {
    const passed = [...api.matchAll(/revokeMagicLinksForCard\(jobCardId, '([a-z_]+)'/g)].map((m) => m[1]);
    const allowed = (readFileSync('lib/magic-link.ts', 'utf8').match(/export type RevokeReason =([^;]+);/) ?? [])[1] ?? '';
    return passed.length > 0 && passed.every((r) => allowed.includes(`'${r}'`));
  })());
  check('  …and the customer is told WHICH, not a single vague sentence', (() => {
    const copied = [...customerPage.matchAll(/^\s{2}([a-z_]+): \{$/gm)].map((m) => m[1]);
    return ['declined', 'cancelled', 'superseded', 'invoiced'].every((r) => copied.includes(r));
  })(), 'REVOKED_COPY carries a reason-specific page for each');

  console.log('\n— a garage decline moves the VERSION too, not only the card —');
  check('the live version is marked declined in the same transaction',
    /to === 'declined'[\s\S]{0,600}?quoteVersion\.updateMany\([\s\S]{0,200}?status: 'declined'/.test(api),
    'the card said declined while its QuoteVersion stayed `sent` — two states, one moving');
  check('  …recorded as GARAGE-recorded, never customer-attested',
    /to === 'declined'[\s\S]{0,700}?responded_by_user: scope\.userId/.test(api)
    && !/to === 'declined'[\s\S]{0,700}?responded_ip/.test(api),
    'responded_by_user set and ip/user-agent left null — the absence is the honest signal');

  console.log('\n— and the reopen does not strand anybody —');
  check('acceptance mints NO link, deliberately', (() => {
    const acc = readFileSync('lib/quote-acceptance.ts', 'utf8');
    return /NO magic_link_id/.test(acc);
  })(), 'the credential belonged to the offer, and the agreement is not an offer');
  check('  …and re-sending a quote mints a fresh one', (() => {
    const send = readFileSync('pages/api/quote-send.ts', 'utf8');
    return /createMagicLink\(/.test(send) && /revokeMagicLinksForCard/.test(send);
  })(), 'so a declined card that is re-quoted gets a live link again');

  console.log('\n— one rule for a decline, in one place —');
  check('the metrics read a decline from the VERSION', /if \(v\.status !== 'declined'\) continue;/.test(metrics));
  check('  …and the card query no longer fetches declined cards for nobody',
    !/ACCEPTED_ONWARD, 'declined'\]/.test(metrics),
    'two readers of one fact is how they come to disagree, and on 2026-10-14 they did');

  console.log('\n— and the screen says which state it is in —');
  check('the pill reads the STATUS before the booking',
    /status === 'declined'[\s\S]{0,200}?t\('status\.declined'\)/.test(workspace),
    '"Not booked" on a declined card is true and reads as work still to arrange');
  check('  …and the reopen button says reopen, not accept',
    /quoteActions\.reopenBook/.test(workspace) && /status === 'declined' \? 'quoteActions\.reopenBook'/.test(workspace));

  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
} catch (e) {
  check('run completed', false, describeError(e));
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
}
process.exit(out.includes('F') ? 1 : 0);
