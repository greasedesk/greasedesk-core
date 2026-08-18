/**
 * File: scripts/send-outcome-gate.mjs
 * THE THREE SILENCES ARE DIFFERENT SENTENCES — and each names only what it knows.
 *
 * The defect was never missing information: sendNotification returns a discriminated skipCode for
 * every failure. Each caller threw it away. So the assertions that matter here are about
 * DISTINGUISHABILITY (do the branches actually differ?) and ATTRIBUTION (does a branch name a cause
 * it established?) — not about any particular wording, which may be improved freely.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { describeSendFailure } = await import('../lib/send-outcome.ts');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const F = (skipCode, extra = {}) => ({ ok: false, status: 'skipped', skipCode, ...extra });
const ctx = { channel: 'sms', customerName: 'Dolores Nkemelu' };

// ── 1. THE THREE CASES THE OWNER NAMED ───────────────────────────────────────────────────────────
console.log('\n— no number on file / blocked by policy / provider rejected —');
const noNumber = describeSendFailure(F('no_recipient'), ctx);
const blocked  = describeSendFailure(F('demo_tenant'), ctx);
const rejected = describeSendFailure({ ok: false, status: 'failed', reason: 'Twilio 21211: invalid To number' }, ctx);

check('no-number names the missing number', /mobile number/i.test(noNumber.message) && noNumber.code === 'no_recipient', noNumber.message);
check('policy block names the POLICY, not a delivery failure',
  /demo tenant/i.test(blocked.message) && !/provider|couldn|failed|reject/i.test(blocked.message), blocked.message);
check('provider rejection names the provider AND carries its reason',
  /provider rejected/i.test(rejected.message) && /21211/.test(rejected.message), rejected.message);

// THE DISCRIMINATING ASSERTION. A collapse is precisely three equal strings; if these ever agree,
// the mapping has stopped mapping. This is the check the old code would have failed.
const three = [noNumber.message, blocked.message, rejected.message];
check('the three are DISTINCT — a collapse is three equal strings', new Set(three).size === 3,
  `${new Set(three).size} distinct of 3`);

// ── 2. PROVE RED: the collapse this replaced ─────────────────────────────────────────────────────
console.log('\n— the gate can fail: the old expression, run against the same three inputs —');
const oldCopy = (sent) => sent.skipCode === 'allowance_spent'
  ? 'Your SMS allowance ran out as this was sending — the quote is frozen and the link below still works.'
  : sent.suppressed
    ? 'That customer has opted out — the link below still works.'
    : 'The text couldn’t be sent, but the link below still works.';
const oldThree = [oldCopy(F('no_recipient')), oldCopy(F('demo_tenant')), oldCopy({ ok: false, status: 'failed' })];
check('the OLD mapping produces ONE sentence for all three', new Set(oldThree).size === 1,
  `"${oldThree[0]}"`);
console.log('   (so the assertion above is discriminating, not satisfied by any mapping at all)\n');

// ── 3. RETRYABILITY FOLLOWS THE CAUSE ────────────────────────────────────────────────────────────
console.log('— only a provider rejection is worth retrying —');
check('a provider rejection is retryable', rejected.retryable === true);
for (const c of ['no_recipient', 'demo_tenant', 'opted_out', 'not_configured', 'allowance_spent', 'no_renderer', 'unknown_template']) {
  const r = describeSendFailure(F(c), ctx);
  check(`${c} is NOT retryable`, r.retryable === false, r.message);
}

// ── 4. NO BRANCH BLAMES THE PROVIDER IT DID NOT CONTACT ──────────────────────────────────────────
console.log('\n— attribution: a branch may only name a cause it established —');
let blamed = [];
for (const c of ['no_recipient', 'demo_tenant', 'opted_out', 'not_configured', 'allowance_spent', 'no_renderer', 'unknown_template']) {
  const m = describeSendFailure(F(c), ctx).message;
  if (/provider/i.test(m)) blamed.push(`${c}: ${m}`);
}
check('no SKIPPED branch mentions the provider', blamed.length === 0, blamed.join(' | ') || 'clean across 7 skip codes');
check('the check is discriminating — the FAILED branch does mention it', /provider/i.test(rejected.message));

// ── 5. BOTH CALLERS ROUTE THROUGH IT ─────────────────────────────────────────────────────────────
console.log('\n— one mapping, both senders —');
for (const f of ['pages/api/quote-send.ts', 'pages/api/invoice-sms.ts']) {
  const src = readFileSync(f, 'utf8');
  check(`${f.split('/').pop()} calls describeSendFailure`, /describeSendFailure\(/.test(src));
  // Strip comments first: the files EXPLAIN the sentence they no longer emit, and a scan that
  // matched that explanation would pass on prose while the code still collapsed.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(`${f.split('/').pop()} no longer emits the catch-all sentence`, !/couldn’t be sent/.test(code));
  check(`  …and the explanation of why survives in the comments`, /couldn’t be sent/.test(src),
    'the rule is documented where the next reader will be');
}
const sms = readFileSync('pages/api/invoice-sms.ts', 'utf8');
check('invoice-sms only claims 502 when the upstream actually failed',
  /res\.status\(why\.retryable \? 502 : 409\)/.test(sms),
  '502 asserts an upstream failure; a demo block is not one');
check('and it only advises retrying when retrying could work', /why\.retryable \? ' Please try again shortly\.'/.test(sms));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
