/**
 * File: scripts/dvsa-failure-reason-gate.mjs
 * @gate-requires: none
 *
 * A LOOKUP THAT PRODUCED NOTHING MUST SAY WHY.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * dvsaLookup returned `DvsaVehicle | null`, and lib/dvsa's own header described that as
 * best-effort: "any failure returns null so the caller falls back to manual entry". That is right
 * for a BUTTON, where a person is watching and can press it again. It was wrong everywhere else,
 * and it was wrong on screen.
 *
 * One null stood for all of: DVSA has no record of this plate (404), the shared key's window is
 * spent (429), the credential was rejected (403), we gave up waiting (our own 5s abort), DVSA is
 * unwell (5xx), the response was unreadable, this deployment has no credential at all, and a
 * caller passed an empty string. Those are eight different afternoons. The one that mattered is
 * 429: ONE key serves every tenant with no cache and no cap of ours, so an exhausted window is the
 * likeliest failure, not the rarest — and it read to a garage as "DVSA has never heard of this car".
 *
 * ── AND IT BLOCKED THE NEXT THING ───────────────────────────────────────────────────────────────
 * It is the stated prerequisite for any scheduled refresh. A sweep that cannot see a 429 keeps
 * calling, records "no DVSA record" against every remaining car, and finishes with a confident
 * report that most of the fleet is unknown to DVSA — every line of it false, and the run looking
 * complete. That is the same failure as a gate reporting 0 red over a population it never loaded.
 *
 * ── WHAT IS GUARDED HERE ────────────────────────────────────────────────────────────────────────
 *   1. THE MAP. Status → reason, and the two groupings that are deliberate (401 with 403; every
 *      other non-ok as `unavailable`) asserted as grouping rather than left to look accidental.
 *   2. COMPLETENESS FROM THE TYPE, not from a list written here. The union is read out of
 *      lib/dvsa.ts source and every member must get its own sentence — so a ninth reason added
 *      later fails this gate instead of silently falling to the default.
 *   3. DISTINCTNESS. Eight reasons, eight different sentences. A map that compiles and says the
 *      same thing twice has not told anybody anything.
 *   4. EVERY CALLER. All four, each asserted on the thing IT has to do differently: the two APIs
 *      return the reason, the mint records it without acting on it, and the sweep STOPS.
 *
 * ── WHAT IS NOT PROVED HERE ─────────────────────────────────────────────────────────────────────
 * That DVSA actually sends a 429 when the window is spent, or a 403 for a bad secret. Those are
 * their contract, not ours. What is proved is that each status we might receive becomes the right
 * reason, and that each reason reaches the surface that has to act on it.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { hasKey } = await import('../lib/anchored-match.ts');
const D = await import('../lib/dvsa.ts');
const R = await import('../lib/mot-refresh.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. STATUS → REASON ──────────────────────────────────────────────────────────────────────────
console.log('— the map from what DVSA sent to what it means —');
for (const [status, want] of [[404, 'not_found'], [429, 'rate_limited'], [403, 'forbidden'], [401, 'forbidden'],
                              [500, 'unavailable'], [502, 'unavailable'], [503, 'unavailable'], [400, 'unavailable']]) {
  check(`${status} → ${want}`, D.dvsaFailureFromStatus(status) === want, D.dvsaFailureFromStatus(status));
}
// THE GROUPINGS, ASSERTED AS GROUPINGS. 401 and 403 share a reason because no caller has a
// different move for them; a later split would be a real decision and should fail here first.
check('401 and 403 are deliberately the SAME reason',
  D.dvsaFailureFromStatus(401) === D.dvsaFailureFromStatus(403),
  'both mean the credential did not get us in, and no caller treats them differently');
check('  …and 404 is NOT grouped with them',
  D.dvsaFailureFromStatus(404) !== D.dvsaFailureFromStatus(403),
  'news about the car vs news about us — the distinction the whole change exists for');
check('a 400 is unavailable, not not_found',
  D.dvsaFailureFromStatus(400) === 'unavailable',
  'we cannot tell a malformed plate from DVSA disliking one it will never like — so do not claim to');

// ── 2. COMPLETENESS, READ OFF THE TYPE ──────────────────────────────────────────────────────────
// Enumerated from the SOURCE union rather than a list in this file: a list here would agree with
// itself for ever, and the failure mode being guarded is a ninth reason added without a sentence.
console.log('\n— every reason the type admits has its own sentence —');
const dvsaSrc = readFileSync('lib/dvsa.ts', 'utf8');
const unionBlock = dvsaSrc.slice(dvsaSrc.indexOf('export type DvsaFailure ='));
const union = unionBlock.slice(0, unionBlock.indexOf(';'));
const REASONS = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check('the DvsaFailure union was found in source and is not empty', REASONS.length >= 5, `${REASONS.length} found: ${REASONS.join(', ')}`);
check('  …and the five the ruling named are all in it',
  ['not_found', 'rate_limited', 'forbidden', 'timeout', 'unconfigured'].every((r) => REASONS.includes(r)),
  REASONS.join(', '));

const generic = R.failureSentence(undefined);
const sentences = new Map();
for (const r of REASONS) {
  const s = R.failureSentence(r);
  sentences.set(r, s);
  check(`${r.padEnd(16)} has its own sentence`, typeof s === 'string' && s.length > 10 && s !== generic, s);
}
check('all of them are DISTINCT from each other', new Set(sentences.values()).size === REASONS.length,
  `${new Set(sentences.values()).size} distinct for ${REASONS.length} reasons`);
check('an unnamed reason keeps the ORIGINAL wording', /didn’t answer/.test(generic) && /nothing was learned/.test(generic),
  'an un-migrated caller must read exactly as it did, not invent a diagnosis it does not have');

// WHAT EACH SENTENCE HAS TO CARRY — the next move, not just the fault.
console.log('\n— and each one names the next move —');
check('rate_limited tells the reader to wait', /again in a few minutes/i.test(sentences.get('rate_limited')), sentences.get('rate_limited'));
check('forbidden says it will not fix itself', /fixing here, not retrying/i.test(sentences.get('forbidden')), sentences.get('forbidden'));
check('not_found points at the PLATE, not at DVSA', /check the plate/i.test(sentences.get('not_found')), sentences.get('not_found'));
check('not_found is the only one that does NOT say nothing was learned',
  !/nothing was learned/i.test(sentences.get('not_found'))
  && REASONS.filter((r) => r !== 'not_found' && r !== 'no_registration').every((r) => /nothing was learned/i.test(sentences.get(r))),
  'a 404 IS an answer — just not an answer about an MOT');

// ── 3. THE OUTCOME CARRIES IT ───────────────────────────────────────────────────────────────────
console.log('\n— refreshOutcome passes the reason through —');
const limited = R.refreshOutcome({ answered: false, failure: 'rate_limited', heldBefore: '2026-07-22', heldAfter: null, stillDue: true });
const missing = R.refreshOutcome({ answered: false, failure: 'not_found', heldBefore: '2026-07-22', heldAfter: null, stillDue: true });
check('a rate-limited check is kind no_answer', limited.kind === 'no_answer', limited.kind);
check('  …and carries failure=rate_limited', limited.failure === 'rate_limited', String(limited.failure));
check('  …and says so in the sentence', /rate-limiting/i.test(limited.sentence), limited.sentence);
check('a not-found check says something DIFFERENT', missing.sentence !== limited.sentence, missing.sentence);
check('  …and both keep the date they had', limited.expiry === '2026-07-22' && missing.expiry === '2026-07-22',
  'an absent answer is not an absent MOT');
check('  …and neither claims a check', !/[Cc]hecked/.test(limited.sentence) && !/[Cc]hecked/.test(missing.sentence),
  'the honest-null rule at the sharpest end');
const ok = R.refreshOutcome({ answered: true, failure: null, heldBefore: '2026-07-22', heldAfter: '2027-07-25', stillDue: false });
check('an ANSWER carries failure=null', ok.failure === null, String(ok.failure));

// ── 4. EVERY CALLER, ON THE THING IT HAS TO DO ──────────────────────────────────────────────────
console.log('\n— all four callers —');
const motApi = readFileSync('pages/api/mot-refresh.ts', 'utf8');
const dvsaApi = readFileSync('pages/api/dvsa-lookup.ts', 'utf8');
const mint = readFileSync('lib/mot-mint-refresh.ts', 'utf8');
const sweep = readFileSync('scripts/dvsa-backfill.mjs', 'utf8');

// Property-key matchers go through lib/anchored-match (anchored-match-gate): a bare /reason:/ would
// match the word in any comment or object in the file and report a wiring that is not there.
check('mot-refresh narrows on !r.ok rather than a truthiness check', /if \(!r\.ok\)/.test(motApi),
  'the discriminant, so the compiler keeps the vehicle and the reason apart');
check('  …and returns the reason to the browser', hasKey(motApi, 'reason', 'r.reason'), 'reason: r.reason');
check('  …and passes it into refreshOutcome', hasKey(motApi, 'failure', 'r.reason'), 'failure: r.reason');
check('  …and still stamps nothing on a failure',
  motApi.indexOf('if (!r.ok)') < motApi.indexOf('mot_checked_at: checkedAt'),
  'the early return precedes the only write of the stamp');
check('dvsa-lookup returns found:false WITH a reason', hasKey(dvsaApi, 'reason', 'r.reason'), 'reason: r.reason');
check('  …and tells an empty answer apart from a failure', /empty_answer/.test(dvsaApi),
  'DVSA answered about a car it had nothing fillable for — not a failure, and not a retry');
check('the mint RECORDS the reason', hasKey(mint, 'reason', 'r.reason'), 'reason: r.reason');
// The waiver must sit ON the line or the one ABOVE it (anchored-match-gate reads those two only),
// so the reasoning goes here and the waiver goes immediately below: this is deliberately an EXACT
// multi-key literal rather than a key lookup, because hasKey would prove each of the four fields
// appears SOMEWHERE in the file — which is precisely what would stay green if the failure return
// were split up or a field dropped. "All four travel together in one return" is the assertion.
// @anchored-ok: an exact multi-key literal asserting four fields travel in ONE return, not a key lookup
check('  …and still never blocks on it', /answered: false, reason: r\.reason, expiryChanged: null, written: \[\]/.test(mint),
  'the decision is unchanged for every reason; only the diagnosis is new');
check('  …and names OUR deadline a timeout, not an outage', hasKey(mint, 'reason', "'timeout'"),
  'the race losing is us giving up at MINT_LOOKUP_TIMEOUT_MS');

// THE SWEEP IS THE ONE THAT MUST ACT. Everything above records; this one stops.
check('the sweep STOPS on a spent window', /r\.reason === 'rate_limited'/.test(sweep), "r.reason === 'rate_limited'");
check('  …and on a refused credential too', /r\.reason === 'forbidden'/.test(sweep), 'no later car will fare better');
check('  …with a break, not a continue', /halted = \{[\s\S]{0,400}?\n\s*break;/.test(sweep),
  'a continue would keep spending the window and keep recording falsehoods');
check('  …and reports the run as PARTIAL', /PARTIAL RUN — STOPPED AT/.test(sweep), 'counts that cover 40 of 365 cars must not be printed as if they covered 365');
check('  …and says the untouched cars are untouched', /UNCHANGED and nothing above is a statement about them/.test(sweep),
  'the difference between "we found nothing" and "we did not look"');
check('  …and a completed run says so explicitly', /COMPLETE — all \$\{vehicles\.length\} car/.test(sweep),
  'so the absence of the partial line is a positive statement, not a silence');
check('a per-car miss now records WHICH miss', /no reading: \$\{r\.reason\}/.test(sweep), 'was "no DVSA record or lookup failed" for all of them');

// ── 5. THE PROOFS BITE ──────────────────────────────────────────────────────────────────────────
// Every source scan above is a string match, and a string match that cannot fail found decoration.
console.log('\n— the scans find a planted case and reject a broken one —');
check('RP1 a map that collapsed 429 into not_found would be caught',
  ((s) => s === 'rate_limited')(D.dvsaFailureFromStatus(429)) && D.dvsaFailureFromStatus(429) !== D.dvsaFailureFromStatus(404),
  'asserted as inequality, so a one-line "simplification" to a shared reason goes red');
const BROKEN_SENTENCES = ['not_found', 'rate_limited'].map(() => 'DVSA didn’t answer — nothing was learned.');
check('RP2 a reason map that said the same thing twice would be caught',
  new Set(BROKEN_SENTENCES).size === 1 && new Set(['not_found', 'rate_limited'].map((r) => R.failureSentence(r))).size === 2,
  'the distinctness clause is what fails on a copy-paste');
const BROKEN_SWEEP = "if (!r.ok) { missed += 1; continue; }";
check('RP3 the sweep scan rejects a loop that only continues',
  !/r\.reason === 'rate_limited'/.test(BROKEN_SWEEP) && /r\.reason === 'rate_limited'/.test(sweep),
  'the clause is about the STOP, and a continue-only loop has none');
const BROKEN_API = "const data = await dvsaLookup(reg);\n  if (!data) return res.status(200).json({ found: false });";
check('RP4 the API scan rejects the pre-change shape',
  !hasKey(BROKEN_API, 'reason', 'r.reason') && hasKey(dvsaApi, 'reason', 'r.reason'),
  'the old bare found:false does not satisfy the clause that replaced it');
check('RP5 completeness is read from the type, so a 9th reason without a sentence fails',
  REASONS.every((r) => R.failureSentence(r) !== generic)
  && R.failureSentence('a_reason_nobody_wrote_a_sentence_for') === generic,
  'an unknown reason falls to the default — which is exactly what the completeness clause forbids for a declared one');

// ── VERDICT ─────────────────────────────────────────────────────────────────────────────────────
const failed = out.filter((r) => r === 'F').length;
console.log(`\n${failed} failures of ${out.length}`);
process.exit(failed ? 1 : 0);
