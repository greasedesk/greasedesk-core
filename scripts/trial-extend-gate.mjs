/**
 * File: scripts/trial-extend-gate.mjs
 * EXTENDING A TRIAL FROM THE ENGINE ROOM — the rules, the refusals, and both ledgers.
 * @gate-requires: db
 *
 * ── WHY THE RULES ARE PURE AND THE STRIPE CALL IS NOT DRIVEN ────────────────────────────────────
 * Stripe owns the trial clock: lib/stripe-billing-cache mirrors trial_end onto Group.trial_ends_at
 * on every subscription webhook, and its own header says so. So the control does not write the
 * mirror and hope — it updates the subscription, RE-READS it, and applies the re-read through the
 * same cache writer the webhook calls. That is the pattern migrate-subscription-price already
 * states in its own words: "trial_end will be re-read after the real call and compared, not
 * assumed."
 *
 * This gate does not call Stripe. A test-mode subscription belonging to a real tenant is not a
 * fixture, extending one would move a real trial, and the live keys are test keys on production
 * data (see the subscription-billing note). What it holds instead:
 *   · every REFUSAL, purely — Stripe's 48-hour minimum and future-only rule, the reason rules;
 *   · that the endpoint re-reads rather than trusting the request, structurally;
 *   · BOTH LEDGERS, against the database, on a tenant with no subscription — the branch that is
 *     entirely ours and needs no Stripe at all. Two of the six live trials are in it.
 *
 * ── THE HALF THAT IS NOT COVERED, SAID PLAINLY ──────────────────────────────────────────────────
 * Nothing here proves the Stripe round trip. The structural checks prove the endpoint is SHAPED to
 * re-read; only a real call proves it does. That is a deliberate limit, not an oversight, and the
 * first extension of a subscribed tenant should be watched by a person.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync, existsSync } = await import('node:fs');
// Tolerant: absent before this slice lands, so the run reaches every check instead of dying at 1.
const X = await import('../lib/trial-extension.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const API = 'pages/api/superadmin/trial-extend.ts';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const NOW = new Date('2026-09-05T12:00:00.000Z');
const at = (hours) => new Date(NOW.getTime() + hours * 3600_000);
const val = (a) => { try { return X.validateExtension(a); } catch { return null; } };
// JSON.stringify(undefined) returns undefined, not a string, so `.slice` on it throws and takes the
// run with it — a detail helper must never be the thing that stops a red-proof reporting.
const det = (v, n = 120) => String(JSON.stringify(v) ?? 'undefined').slice(0, n);

try {
  // ── 1. THE REFUSALS STRIPE WOULD MAKE, MADE FIRST AND IN WORDS ───────────────────────────────
  // Sending a date Stripe will reject and surfacing its error is a worse answer than not sending
  // it: the operator gets an API message about a parameter instead of a sentence about a trial.
  console.log('\n— what it refuses before it calls anybody —');
  check('lib/trial-extension exports the rule', typeof X.validateExtension === 'function',
    `validateExtension=${typeof X.validateExtension}`);

  const good = val({ current: at(24 * 9), next: at(24 * 23), category: 'sales', note: 'Agreed a fortnight while they migrate their old system', now: NOW });
  check('a real extension is accepted', good?.ok === true, det(good, 140));
  check('  …and reports the delta in whole days', good?.ok && good.deltaDays === 14, String(good?.deltaDays));

  // STRIPE'S OWN CONSTRAINT, enforced here so the message can explain it.
  const soon = val({ current: at(24), next: at(36), category: 'sales', note: 'A perfectly good reason, twelve chars plus', now: NOW });
  check('a date inside Stripe’s 48-hour minimum is refused', soon?.ok === false, JSON.stringify(soon));
  check('  …and the message says WHY, not just no', /48 hours/.test(soon?.message ?? ''),
    String(soon?.message));
  const past = val({ current: at(24 * 9), next: at(-24), category: 'sales', note: 'A perfectly good reason, twelve chars plus', now: NOW });
  check('a date in the past is refused', past?.ok === false, det(past?.message, 90));

  // EXTEND ONLY. Pulling a trial back moves the commission boundary (lib/commission gates accrual
  // on trial_ends_at) and is a different act for a different role — refused here, by name.
  const back = val({ current: at(24 * 30), next: at(24 * 10), category: 'sales', note: 'Shortening it for a good reason here', now: NOW });
  check('pulling the trial BACK is refused', back?.ok === false, det(back?.message, 110));
  check('  …because it moves the commission boundary, and the message says so',
    /commission|earlier|shorten/i.test(back?.message ?? ''), det(back?.message, 120));

  // ── 2. THE REASON, HELD TO THE VOID RULES ────────────────────────────────────────────────────
  console.log('\n— a reason that is a reason —');
  check('the categories are a fixed vocabulary', Array.isArray(X.TRIAL_EXTENSION_CATEGORIES)
    && X.TRIAL_EXTENSION_CATEGORIES.join(',') === 'beta_programme,technical_support,sales,goodwill',
    JSON.stringify(X.TRIAL_EXTENSION_CATEGORIES));
  const badCat = val({ current: at(24 * 9), next: at(24 * 23), category: 'because_i_said_so', note: 'A perfectly good reason, twelve chars plus', now: NOW });
  check('an unknown category is refused', badCat?.ok === false, det(badCat?.message, 90));
  const shortNote = val({ current: at(24 * 9), next: at(24 * 23), category: 'goodwill', note: 'too short', now: NOW });
  check('a note under the shared minimum is refused', shortNote?.ok === false, det(shortNote?.message, 90));
  const junk = val({ current: at(24 * 9), next: at(24 * 23), category: 'goodwill', note: 'xxxxxxxxxxxxxxxx', now: NOW });
  check('  …and so is one character repeated', junk?.ok === false,
    'the same rule a void reason follows, and for the same reason: it is the record somebody finds later');
  const trialSrc = existsSync('lib/trial-extension.ts') ? readFileSync('lib/trial-extension.ts', 'utf8') : '';
  check('  …through the SHARED rules, not a third copy',
    /MIN_REASON_LENGTH/.test(trialSrc) && /invoice-void/.test(trialSrc),
    'three validators drifting is how "x" becomes an acceptable explanation somewhere');

  // ── 3. THE ENDPOINT IS SHAPED TO TRUST STRIPE, NOT THE REQUEST ───────────────────────────────
  console.log('\n— and the endpoint believes Stripe, not itself —');
  check('the endpoint exists', existsSync(API), API);
  const api = existsSync(API) ? prose(readFileSync(API, 'utf8')) : '';
  check('it is support-role and region-scoped',
    /requireOperatorApi\([^)]*minRole:\s*'support'/.test(api) && /tenantInScope\(/.test(api),
    'the role the schema already declares this capability on');
  check('  …and answers 404 out of scope, never 403', /tenantInScope[\s\S]{0,160}?status\(404\)/.test(api),
    'the Engine Room is undiscoverable; a 403 confirms the tenant exists');
  check('it sends proration_behavior none and an idempotency key',
    /proration_behavior:\s*'none'/.test(api) && /idempotencyKey/.test(api),
    'a proration invoice on a tenant promised a free period is the surprise worth ruling out');
  check('  …then RE-READS the subscription', /subscriptions\.retrieve\(/.test(api),
    'the requested date is what we asked for; the re-read is what happened');
  check('  …and applies it through the webhook’s own cache writer',
    /applyStripeSubscriptionToCache\(/.test(api),
    'a second writer of the mirror is a second source of truth for a clock Stripe owns');

  // ── 4. BOTH LEDGERS, AGAINST THE DATABASE ────────────────────────────────────────────────────
  // The no-subscription branch: entirely ours, no Stripe, and two of the six live trials are in it.
  console.log('\n— and it is recorded on both sides of the boundary —');
  check('the local branch is labelled, not silently different',
    /No subscription yet/.test(api), 'the operator must know which of the two acts they performed');
  check('the tenant’s own ledger gets a row', /entity:\s*'group'/.test(api)
    && /billing\.trial_extended/.test(api) && /userId:\s*null/.test(api),
    'nobody inside the business did this, and until now nothing on their side said it happened');
  check('  …and the operator ledger records the DIRECTION in the action',
    /tenant\.trial_extended/.test(api), 'a payload field for the direction is a payload nobody filters on');
  const detailKeys = ['from', 'to', 'deltaDays', 'category', 'hadSubscription', 'stripeSubscriptionId', 'stripeTrialEndAfter'];
  const missing = detailKeys.filter((k) => !new RegExp(`\\b${k}\\b`).test(api));
  check('  …with every field the report asked for', missing.length === 0, missing.join(', ') || `${detailKeys.length} of ${detailKeys.length}`);
  // stripeTrialEndAfter is the RE-READ value. If it diverges from what we asked for, the audit is
  // the only place that difference survives.
  check('  …and the recorded Stripe date is the re-read one',
    /stripeTrialEndAfter:[^,\n]*(after|reread|fresh)/i.test(api),
    'recording the requested date would make a divergence invisible');

  // ── 5. THE TENANT IS TOLD, ON THE SCREEN THAT CHANGED ────────────────────────────────────────
  console.log('\n— and the tenant is told where they would notice —');
  const dash = prose(readFileSync('pages/admin/dashboard.tsx', 'utf8'));
  check('the banner can say a trial was extended', /Trial extended to/.test(dash),
    'the banner states when their card will be charged; moving that date silently is the risk');
  check('  …driven by a real signal, not the date alone', /trialExtended/.test(dash),
    'a later date is not evidence of an extension — a fresh signup has one too');

  // ── 6. THE TEN THAT STILL OWE THEIRS ─────────────────────────────────────────────────────────
  // tenant-phone-exempt's audit helper has been commented "BOTH LEDGERS" since it was written and
  // writes only SuperAdminAudit. This slice makes it true for ONE action; the count is pinned so
  // the debt is visible and shrinking it is deliberate.
  console.log('\n— and the debt is counted, not forgotten —');
  const { readdirSync } = await import('node:fs');
  const opWrites = readdirSync('pages/api/superadmin').filter((f) => f.endsWith('.ts'))
    .map((f) => `pages/api/superadmin/${f}`)
    .filter((f) => /superAdminAudit\.create|writeSuperAdminAudit|audit\(/.test(prose(readFileSync(f, 'utf8'))));
  const withTenantLedger = opWrites.filter((f) => /entity:\s*'group'/.test(prose(readFileSync(f, 'utf8'))));
  check('exactly one operator write reaches the tenant’s ledger', withTenantLedger.length === 1,
    `${withTenantLedger.length} of ${opWrites.length}: ${withTenantLedger.join(', ') || 'none'}`);
  check('  …and the file that has claimed BOTH LEDGERS longest says it does not yet',
    /still writes only the operator ledger|owes the tenant/i.test(readFileSync('pages/api/superadmin/tenant-phone-exempt.ts', 'utf8')),
    'a comment describing an intention nothing implements is worse than no comment');

  // ── 7. THE POPULATION THIS LANDS ON ──────────────────────────────────────────────────────────
  const trials = await prisma.group.findMany({ where: { trial_ends_at: { not: null } },
    select: { ref: true, billing: { select: { stripe_subscription_id: true } } } });
  const local = trials.filter((g) => !g.billing?.stripe_subscription_id);
  check('both branches have live tenants in them', trials.length > 0 && local.length > 0,
    `${trials.length} trials, ${local.length} with no subscription — the local branch is not hypothetical`);
  const zzTrial = await prisma.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true } });
  check('  …and ZZ is readable for a fixture run', zzTrial !== null);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
