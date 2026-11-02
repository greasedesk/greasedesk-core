/**
 * File: scripts/marketing-engine-gate.mjs
 * @gate-requires: none
 *
 * ONE ENGINE, FOUR AUDIENCES, AND THE TWO WAYS THAT GOES WRONG.
 *
 * ── WHAT WAS BUILT, AND WHAT IT REPLACED ────────────────────────────────────────────────────────
 * ProspectSequence was the right state machine with one audience welded into its primary key. Three
 * more audiences arrived — garages on trial, the affiliate waiting list, new affiliates — and the
 * two options were four nullable subject columns of which one is ever set, or four copies of the
 * runner, the switch, the stop reasons and the cron. MarketingEnrolment is the third option:
 * (subject_type, subject_id), one runner, four adapters.
 *
 * ── THE TWO FAILURES THIS GATE EXISTS FOR ──────────────────────────────────────────────────────
 *   1. THE WRONG AUDIENCE'S EMAIL. A polymorphic subject with no foreign key means the one thing
 *      this table can do that nothing else in the product can: address a trial-garage sequence to a
 *      Prospect id. The pair CHECK in the database is the guard; the clauses below prove the CHECK
 *      names exactly the four pairs lib/marketing-engine declares, and that the two cannot drift.
 *   2. TWO CORRECT RULES COLLIDING. lib/prospect-suppression refused any prospecting send to an
 *      address belonging to a GreaseDesk customer, with good reason. Two of these four sequences
 *      write to exactly those people. Routed through that refusal they would send nothing; routed
 *      around it they would have no opt-out at all, because lib/notify::isSuppressed returns false
 *      for every platform send. REFUSE_IF_CUSTOMER is the category that was missing, and §5 asserts
 *      it is per-sequence data rather than an override at a call site.
 *
 * ── AND THE QUIET ONE ───────────────────────────────────────────────────────────────────────────
 * The copy is rows now, not compiled source, so a step can have NO WORDS. The engine must hold at
 * that step: not send an empty email, and not advance as though it had sent one. That is §4 and §8,
 * and it is the clause most likely to be "simplified" by somebody who reads the hold as a bug.
 *
 * ── WHAT IS DELIBERATELY NOT PROVED HERE ────────────────────────────────────────────────────────
 * Anything requiring the four tables to exist. Migration 20261102120000_marketing_engine is the
 * owner's to apply and had not been applied when this was written, so every clause below reads
 * SOURCE, the PURE rules, or renders a real template through react-dom's string renderer. The
 * database-level behaviour — that a stop really is conditional on the pre-state, that the claim
 * really does stop two runs sending one step — is scripts/marketing-engine-db-gate.mjs, which
 * declines until the migration lands rather than passing over tables it cannot see.
 *
 * §1 the migration and the schema describe the same thing   §6 the templates, rendered
 * §2 completeness, enumerated from the engine's own arrays  §7 which domain it leaves from
 * §3 the state machine and the switch                        §8 the wiring, read from source
 * §4 the copy rules                                          §9 red-proofs
 * §5 the audience policy
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { hasKey, countKey, urlUnder } = await import('../lib/anchored-match.ts');
const E = await import('../lib/marketing-engine.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const src = (f) => readFileSync(f, 'utf8');
/** Comments stripped: a file explaining what it does must not satisfy a check about doing it. */
const prose = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MIGRATION = 'prisma/migrations/20261102120000_marketing_engine/migration.sql';
const sql = src(MIGRATION);
const schema = src('prisma/schema.prisma');
const engineSrc = src('lib/marketing-engine.ts');
const storeSrc = prose(src('lib/marketing-store.ts'));
const notifySrc = prose(src('lib/notify.ts'));
const supprSrc = prose(src('lib/marketing-suppression.ts'));
const mailSrc = prose(src('lib/email-service.ts'));
const purgeSrc = prose(src('lib/tenant-purge.ts'));
const tplSrc = src('lib/notification-templates.ts');

// ══ 1. THE MIGRATION AND THE SCHEMA DESCRIBE THE SAME THING ═════════════════════════════════════
// I wrote both of these by hand, which is precisely the case identical-by-construction warns about:
// one side writes a column list, the other matches it, and a one-sided omission is silent. Neither
// is an independent oracle for the other, but comparing them catches the realistic failure — a
// column typed in one place and forgotten in the other — which the drift gate cannot see until the
// migration is applied.
console.log('— the migration and the schema describe the same four tables —');
const MODELS = ['MarketingEnrolment', 'MarketingSending', 'MarketingSendingLease', 'MarketingCopy'];

const sqlColumns = (table) => {
  const i = sql.indexOf(`CREATE TABLE "${table}" (`);
  if (i < 0) return null;
  const body = sql.slice(i, sql.indexOf('\n);', i));
  return new Set([...body.matchAll(/^\s{2}"([a-z_0-9]+)"\s+[A-Z]/gm)].map((m) => m[1]));
};
const schemaFields = (model) => {
  const i = schema.indexOf(`model ${model} {`);
  if (i < 0) return null;
  const body = schema.slice(i, schema.indexOf('\n}', i));
  return new Set([...body.matchAll(/^\s{2}([a-z_][a-z_0-9]*)\s+(String|Int|Boolean|DateTime)/gm)].map((m) => m[1]));
};

for (const m of MODELS) {
  const cols = sqlColumns(m);
  const fields = schemaFields(m);
  check(`${m} exists in both`, !!cols && !!fields, `sql ${cols?.size ?? 0} cols, schema ${fields?.size ?? 0} scalar fields`);
  if (!cols || !fields) continue;
  const missingInSql = [...fields].filter((f) => !cols.has(f));
  const missingInSchema = [...cols].filter((c) => !fields.has(c));
  check(`  …every schema field of ${m} is a column`, missingInSql.length === 0, missingInSql.join(', ') || 'none missing');
  check(`  …every column of ${m} is a schema field`, missingInSchema.length === 0, missingInSchema.join(', ') || 'none extra');
}
// NOT VACUOUS: if the parsers silently matched nothing, every clause above would pass over empty
// sets. The failure a scan cannot report is the one where it never reached its subject.
check('  …and the column parser really found columns', (sqlColumns('MarketingEnrolment')?.size ?? 0) >= 12,
  `${sqlColumns('MarketingEnrolment')?.size ?? 0} columns parsed out of the CREATE TABLE`);

console.log('\n— the pair CHECK names exactly the pairs the engine declares —');
const pairChk = sql.slice(sql.indexOf('MarketingEnrolment_pair_chk'), sql.indexOf('MarketingEnrolment_state_chk'));
for (const k of E.SEQUENCE_KEYS) {
  const want = new RegExp(`"sequence_key"\\s*=\\s*'${k}'\\s*AND\\s*"subject_type"\\s*=\\s*'${E.SUBJECT_OF[k]}'`);
  check(`  ${k} is paired with ${E.SUBJECT_OF[k]} in the database`, want.test(pairChk), 'read out of the migration SQL');
}
check('  …and it names no FIFTH pair the engine does not know',
  [...pairChk.matchAll(/"sequence_key"\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]).every((k) => E.isSequenceKey(k)),
  'a pair added to the CHECK without a key in SEQUENCE_KEYS fails here');
check('  …and the pair count matches the key count',
  [...pairChk.matchAll(/"sequence_key"\s*=\s*'([a-z_]+)'/g)].length === E.SEQUENCE_KEYS.length,
  `${[...pairChk.matchAll(/"sequence_key"\s*=\s*'([a-z_]+)'/g)].length} pairs, ${E.SEQUENCE_KEYS.length} keys`);

const consentChk = sql.slice(sql.indexOf('MarketingEnrolment_consent_chk'), sql.indexOf('MarketingEnrolment_consent_chk') + 400);
check('the consent CHECK names exactly CONSENT_SOURCES',
  E.CONSENT_SOURCES.every((c) => consentChk.includes(`'${c}'`))
  && [...consentChk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).length === E.CONSENT_SOURCES.length,
  E.CONSENT_SOURCES.join(', '));

console.log('\n— the migration is what it declares itself to be —');
check('it declares @migration: additive', /^--\s*@migration:\s*additive\s*$/m.test(sql));
check('  …and contains no ALTER or DROP, so the declaration is true',
  !/\b(ALTER\s+TABLE|DROP\s+(TABLE|COLUMN|CONSTRAINT))\b/i.test(sql),
  'every constraint sits inside its own CREATE TABLE');
check('every state CHECK pairs stopped_at with stopped_reason',
  /"state" = 'stopped'[\s\S]{0,200}"stopped_at" IS NOT NULL\s+AND\s+"stopped_reason" IS NOT NULL/.test(sql),
  'a stop with no reason tells the next reader nothing — carried over from ProspectSequence_stop_chk');
check('  …and an active enrolment is always due at some time',
  /"state" = 'active'\s+AND\s+"next_due_at" IS NOT NULL/.test(sql));
check('the lease is capped at five minutes in the DATABASE',
  /MarketingSendingLease_short_chk[\s\S]{0,160}INTERVAL '5 minutes'/.test(sql),
  `and lib/marketing-engine says ${E.SENDING_LEASE_MAX_SECONDS}s`);
check('  …and the two agree', E.SENDING_LEASE_MAX_SECONDS === 300);
// ── UNIQUE AS A TABLE CONSTRAINT, AND IT HAS TO BE ────────────────────────────────────────────
// A standalone CREATE UNIQUE INDEX classifies CONSTRAINING (lib/migration-deploy-rules), which
// would cost the two-push dance for a uniqueness rule on a table that did not exist a moment ago.
// Inside the CREATE TABLE it is self-contained. migration-class-gate caught the first draft of this
// file declaring `additive` over three standalone indexes — these clauses pin the shape that fixed
// it, so a later "tidy-up" that lifts them back out goes red here as well as there.
const enrolBody = sql.slice(sql.indexOf('CREATE TABLE "MarketingEnrolment" ('), sql.indexOf('\n);', sql.indexOf('CREATE TABLE "MarketingEnrolment" (')));
const copyBody = sql.slice(sql.indexOf('CREATE TABLE "MarketingCopy" ('), sql.indexOf('\n);', sql.indexOf('CREATE TABLE "MarketingCopy" (')));
check('the unsubscribe token is UNIQUE in the database',
  /CONSTRAINT "MarketingEnrolment_unsubscribe_token_key" UNIQUE \("unsubscribe_token"\)/.test(enrolBody),
  'it is the whole lookup from a URL to an enrolment');
check('one enrolment per subject per sequence is UNIQUE in the database',
  /CONSTRAINT "MarketingEnrolment_subject_uq" UNIQUE \("sequence_key", "subject_type", "subject_id"\)/.test(enrolBody),
  'a second is the same person sent the same five emails twice');
check('one copy row per (sequence, step) is UNIQUE in the database',
  /CONSTRAINT "MarketingCopy_step_uq" UNIQUE \("sequence_key", "step"\)/.test(copyBody));
// ON THE STATEMENTS, NOT THE FILE. The usual rule runs backwards here: the comment explaining why
// there is no standalone CREATE UNIQUE INDEX contains the words "CREATE UNIQUE INDEX", so a raw
// scan fails on the file's own reasoning. migration-class-gate strips comments before classifying
// for the same reason, and this is the same question asked twice.
const sqlCode = sql.replace(/--[^\n]*/g, '');
check('  …and no uniqueness is declared as a standalone index, which would classify constraining',
  !/CREATE\s+UNIQUE\s+INDEX/i.test(sqlCode),
  'the whole migration stays additive only because every UNIQUE sits inside its own CREATE TABLE');
check('  …while the NON-unique indexes are outside, where they belong',
  /CREATE INDEX "MarketingEnrolment_due_idx"/.test(sql) && /CREATE INDEX "MarketingEnrolment_subject_idx"/.test(sql),
  'an index rejects no write, so a plain CREATE INDEX is additive wherever it sits');

// ══ 2. COMPLETENESS, ENUMERATED FROM THE ENGINE'S OWN ARRAYS ════════════════════════════════════
// From SEQUENCE_KEYS and STOP_REASONS, never from a list written here and never from a name
// pattern: a fifth sequence added without a label, an audience sentence, a goal or a customer
// policy must fail HERE rather than render as `undefined` to an operator.
console.log('\n— a fifth sequence cannot be added without answering every question —');
const PER_SEQUENCE = { SUBJECT_OF: E.SUBJECT_OF, SEQUENCE_LABEL: E.SEQUENCE_LABEL, SEQUENCE_AUDIENCE: E.SEQUENCE_AUDIENCE, GOAL_STOP: E.GOAL_STOP, CONSENT_OF: E.CONSENT_OF, REFUSE_IF_CUSTOMER: E.REFUSE_IF_CUSTOMER };
for (const [name, map] of Object.entries(PER_SEQUENCE)) {
  const keys = Object.keys(map);
  check(`${name.padEnd(18)} has one entry per sequence and no more`,
    keys.length === E.SEQUENCE_KEYS.length && E.SEQUENCE_KEYS.every((k) => k in map),
    keys.join(', '));
  check(`  …and no entry is undefined`, E.SEQUENCE_KEYS.every((k) => map[k] !== undefined));
}
check('every STOP_REASON has a label', E.STOP_REASONS.every((r) => typeof E.STOP_LABEL[r] === 'string' && E.STOP_LABEL[r].length > 8));
check('  …and no label is reused for two reasons',
  new Set(E.STOP_REASONS.map((r) => E.STOP_LABEL[r])).size === E.STOP_REASONS.length,
  'a map that compiles and says the same thing twice has told nobody anything');
check('every CONSENT_SOURCE has a label', E.CONSENT_SOURCES.every((c) => typeof E.CONSENT_LABEL[c] === 'string'));
check('  …and no two sources share a sentence',
  new Set(E.CONSENT_SOURCES.map((c) => E.CONSENT_LABEL[c])).size === E.CONSENT_SOURCES.length);
check('each sequence has its OWN goal stop',
  new Set(E.SEQUENCE_KEYS.map((k) => E.GOAL_STOP[k])).size === E.SEQUENCE_KEYS.length,
  E.SEQUENCE_KEYS.map((k) => `${k}→${E.GOAL_STOP[k]}`).join('  '));
check('  …and every goal stop is a declared stop reason',
  E.SEQUENCE_KEYS.every((k) => E.STOP_REASONS.includes(E.GOAL_STOP[k])));
check('each sequence has its OWN subject type',
  new Set(E.SEQUENCE_KEYS.map((k) => E.SUBJECT_OF[k])).size === E.SEQUENCE_KEYS.length,
  'four audiences, four tables — a shared one would make the pair CHECK unable to tell them apart');
check('no sequence key is also a subject type',
  !E.SEQUENCE_KEYS.some((k) => E.SUBJECT_TYPES.includes(k)),
  'one word meaning two things is how a draft of this engine called both of them affiliate_waitlist');

console.log('\n— five emails, a week apart —');
check(`STEPS is ${E.STEPS}`, E.STEPS === 5);
check('there is a gap for every step', E.STEP_AFTER_DAYS.length === E.STEPS, E.STEP_AFTER_DAYS.join(','));
check('step 1 goes immediately', E.afterDaysForStep(1) === 0, 'it does not wait for the cron');
check('  …and every later step is a week after the one before',
  [2, 3, 4, 5].every((n) => E.afterDaysForStep(n) === 7), [2, 3, 4, 5].map(E.afterDaysForStep).join(','));

// ══ 3. THE STATE MACHINE AND THE SWITCH ═════════════════════════════════════════════════════════
console.log('\n— afterSend, with no clock and no database —');
const T0 = new Date('2026-11-02T09:00:00.000Z');
for (const step of [1, 2, 3, 4]) {
  const r = E.afterSend(step, T0);
  check(`step ${step} → active, step ${step + 1}, seven days on`,
    r.state === 'active' && r.next_step === step + 1
    && r.next_due_at.getTime() === T0.getTime() + 7 * 86_400_000,
    r.state === 'active' ? r.next_due_at.toISOString() : r.state);
}
const last = E.afterSend(E.STEPS, T0);
check(`step ${E.STEPS} ENDS it, with a reason`, last.state === 'stopped' && last.stopped_reason === 'completed',
  'the last step is a stop like every other, never a silent stall');
check('  …and nothing ever returns a step past the last',
  [1, 2, 3, 4, 5].every((n) => { const r = E.afterSend(n, T0); return r.state === 'stopped' || r.next_step <= E.STEPS; }));

console.log('\n— the switch, and the lease that is not the switch —');
const LEASE_ID = 'enr-1';
check('NO ROW means OFF', E.sendingAllows(null, null, { now: T0 }) === false,
  'the default, and the state every sequence ships in');
check('a row saying false means OFF', E.sendingAllows({ enabled: false }, null, { now: T0 }) === false);
check('a row saying true means ON', E.sendingAllows({ enabled: true }, null, { now: T0 }) === true);
const liveLease = { enrolment_id: LEASE_ID, enabled: true, expires_at: new Date(T0.getTime() + 60_000) };
check('a live lease overrides the switch FOR ITS OWN enrolment',
  E.sendingAllows(null, liveLease, { now: T0, enrolmentId: LEASE_ID }) === true);
check('  …and reaches no other enrolment',
  E.sendingAllows(null, liveLease, { now: T0, enrolmentId: 'enr-2' }) === false);
check('  …and no cron run, which names none',
  E.sendingAllows(null, liveLease, { now: T0 }) === false,
  'this is what stops a gate lease releasing mail to every real address');
check('an EXPIRED lease is ignored',
  E.sendingAllows(null, { ...liveLease, expires_at: new Date(T0.getTime() - 1) }, { now: T0, enrolmentId: LEASE_ID }) === false,
  'so one left behind by a killed process needs nobody to clean up after it');
check('a lease can also hold a sequence OFF while the owner has it on',
  E.sendingAllows({ enabled: true }, { ...liveLease, enabled: false }, { now: T0, enrolmentId: LEASE_ID }) === false);

console.log('\n— queued is never shown as running —');
const ACTIVE = { state: 'active', stopped_reason: null, last_sent_at: null, next_step: 1 };
check('no enrolment → none', E.enrolmentState(null, { sendingOn: true }).kind === 'none');
check('active, switch OFF → queued (switched_off)',
  JSON.stringify(E.enrolmentState(ACTIVE, { sendingOn: false })) === JSON.stringify({ kind: 'queued', why: 'switched_off' }));
check('active, switch on, nothing sent → queued (not_yet_sent)',
  JSON.stringify(E.enrolmentState(ACTIVE, { sendingOn: true, hasCopy: true })) === JSON.stringify({ kind: 'queued', why: 'not_yet_sent' }));
check('active, switch on, NO COPY → holding, naming the step',
  JSON.stringify(E.enrolmentState({ ...ACTIVE, next_step: 3 }, { sendingOn: true, hasCopy: false })) === JSON.stringify({ kind: 'holding', step: 3 }),
  'the state the old engine could not express, because copy was compiled in and therefore always there');
check('  …and holding beats not_yet_sent, so the screen names the real cause',
  E.enrolmentState(ACTIVE, { sendingOn: true, hasCopy: false }).kind === 'holding');
check('  …and switched_off beats holding, because that is the one the owner can fix',
  E.enrolmentState(ACTIVE, { sendingOn: false, hasCopy: false }).kind === 'queued');
check('active with something sent → running',
  E.enrolmentState({ ...ACTIVE, last_sent_at: T0, next_step: 2 }, { sendingOn: true, hasCopy: true }).kind === 'running');
check('stopped → stopped, carrying the reason',
  JSON.stringify(E.enrolmentState({ state: 'stopped', stopped_reason: 'first_payment', last_sent_at: T0, next_step: 3 }, { sendingOn: true })) === JSON.stringify({ kind: 'stopped', reason: 'first_payment' }));
check('a stopped enrolment with no reason reads as completed, not as blank',
  E.enrolmentState({ state: 'stopped', stopped_reason: null, last_sent_at: T0, next_step: 5 }, { sendingOn: true }).reason === 'completed');
check('every state has a label, and none of them is undefined',
  [E.enrolmentState(null, { sendingOn: true }), ACTIVE && E.enrolmentState(ACTIVE, { sendingOn: false }),
   E.enrolmentState(ACTIVE, { sendingOn: true, hasCopy: false }), E.enrolmentState({ ...ACTIVE, last_sent_at: T0 }, { sendingOn: true, hasCopy: true }),
   E.enrolmentState({ state: 'stopped', stopped_reason: 'joined', last_sent_at: null, next_step: 1 }, { sendingOn: true })]
    .every((s) => typeof E.stateLabel(s) === 'string' && E.stateLabel(s).length > 5));
check('the sentence a rep reads never calls a queued follow-up sent',
  !/\bhas been sent\b/.test(E.savedSentence(E.enrolmentState(ACTIVE, { sendingOn: false })))
  && /has been sent/.test(E.savedSentence(E.enrolmentState({ ...ACTIVE, last_sent_at: T0 }, { sendingOn: true, hasCopy: true }))),
  'a rep standing in front of a garage owner must never be told an email is on its way when it is not');
check('  …and a HELD one says so rather than promising the hour',
  /HELD/.test(E.savedSentence(E.enrolmentState(ACTIVE, { sendingOn: true, hasCopy: false })))
  && !/within the hour/.test(E.savedSentence(E.enrolmentState(ACTIVE, { sendingOn: true, hasCopy: false }))));

// ══ 4. THE COPY RULES ═══════════════════════════════════════════════════════════════════════════
console.log('\n— a step with no words holds, and is never sent empty —');
check('no row is not sendable', E.copyIsSendable(null) === false);
check('a blank subject is not sendable', E.copyIsSendable({ subject: '', body: 'x' }) === false);
check('a blank body is not sendable', E.copyIsSendable({ subject: 'x', body: '' }) === false);
check('WHITESPACE is blank', E.copyIsSendable({ subject: '   ', body: '\n\t ' }) === false,
  'which is why the rule is here and not a CHECK on <> \'\' — three spaces would pass that');
check('both written is sendable', E.copyIsSendable({ subject: 'x', body: 'y' }) === true);

console.log('\n— the button is both columns or neither —');
check('both → a cta', JSON.stringify(E.ctaOf({ subject: 's', body: 'b', cta_label: 'Go', cta_url: 'https://x.test' })) === JSON.stringify({ label: 'Go', url: 'https://x.test' }));
check('label alone → none', E.ctaOf({ subject: 's', body: 'b', cta_label: 'Go', cta_url: null }) === null);
check('url alone → none', E.ctaOf({ subject: 's', body: 'b', cta_label: null, cta_url: 'https://x.test' }) === null);
check('blank-but-present counts as absent', E.ctaOf({ subject: 's', body: 'b', cta_label: '  ', cta_url: 'https://x.test' }) === null);

console.log('\n— the button link is refused, not escaped —');
check('https is allowed', E.ctaUrlAllowed('https://greasedesk.com/pricing') === true);
check('http is allowed', E.ctaUrlAllowed('http://greasedesk.com') === true);
for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'JavaScript:alert(1)', '/pricing', 'greasedesk.com', '', '   ', 'mailto:a@b.c']) {
  check(`refused: ${JSON.stringify(bad).padEnd(38)}`, E.ctaUrlAllowed(bad) === false,
    'escaping makes a bad link harmless-LOOKING; refusing makes it absent');
}

// ══ 5. THE AUDIENCE POLICY — THE CATEGORY THAT WAS MISSING ══════════════════════════════════════
console.log('\n— who may be written to even though they are a customer —');
check('garage_prospect refuses a customer\'s address', E.REFUSE_IF_CUSTOMER.garage_prospect === true,
  'the worst outcome this feature can produce, and it is refused at the send regardless of any sequence stopping');
check('trial_garage does NOT', E.REFUSE_IF_CUSTOMER.trial_garage === false,
  'their audience IS our customers — refusing them would silence the sequence entirely');
check('affiliate_new does NOT', E.REFUSE_IF_CUSTOMER.affiliate_new === false);
check('affiliate_interest does NOT', E.REFUSE_IF_CUSTOMER.affiliate_interest === false,
  'somebody on the waiting list may well be a customer; the list is about the programme, not about buying');
check('exactly ONE sequence refuses on customer status',
  Object.values(E.REFUSE_IF_CUSTOMER).filter((v) => v === true).length === 1,
  'asserted as a count, so flipping a second one on "for symmetry" goes red here');
check('  …and it is the one with no prior relationship',
  E.SEQUENCE_KEYS.filter((k) => E.REFUSE_IF_CUSTOMER[k]).join() === 'garage_prospect');
check('the policy is DATA, not a branch at the call site',
  /import \{[^}]*REFUSE_IF_CUSTOMER[^}]*\} from '@\/lib\/marketing-engine'/.test(supprSrc)
  && /REFUSE_IF_CUSTOMER\[sequence\] === true/.test(supprSrc)
  && !/sequence === 'garage_prospect'/.test(supprSrc),
  'read from the engine and INDEXED BY the sequence — asserted with the absence of a hardcoded branch, which is the shape it would regress to');
check('the suppression question NAMES the sequence',
  /marketingRefusal\(\s*recipient:\s*string,\s*sequence:\s*SequenceKey/.test(supprSrc),
  'a boolean could not have told the four apart, which is how the two rules collided');
check('it FAILS CLOSED', /catch\s*{\s*return 'platform_check_failed';/.test(supprSrc),
  'nobody is owed marketing mail, so an unreadable list refuses rather than risks');
check('  …and the unsubscribe list is asked for EVERY sequence',
  /prospectSuppression\.findUnique/.test(supprSrc)
  && !/wantsCustomerCheck[\s\S]{0,80}prospectSuppression/.test(supprSrc),
  'only the customer half is conditional; one unsubscribe stops all four');
check('its refusal codes do not collide with the tenant marketing ones',
  /'platform_unsubscribed'/.test(supprSrc) && /'platform_check_failed'/.test(supprSrc)
  && !/return 'marketing_check_failed'/.test(supprSrc),
  'lib/notify already has marketing_check_failed for a TENANT\'S customer preference — one code cannot mean two things');

// ══ 6. THE TEMPLATES, RENDERED ══════════════════════════════════════════════════════════════════
console.log('\n— four templates, each declaring its own sequence —');
const T = await import('../lib/notification-templates.ts');
const TPLS = T.NOTIFICATION_TEMPLATES;
const MARKETING_TPL = Object.entries(TPLS).filter(([, v]) => v.platformMarketing);
check('there are exactly as many marketing templates as sequences',
  MARKETING_TPL.length === E.SEQUENCE_KEYS.length,
  MARKETING_TPL.map(([k, v]) => `${k}=${v.platformMarketing}`).join('  '));
check('  …one per sequence, none shared',
  new Set(MARKETING_TPL.map(([, v]) => v.platformMarketing)).size === E.SEQUENCE_KEYS.length);
check('  …and every sequence has one',
  E.SEQUENCE_KEYS.every((k) => MARKETING_TPL.some(([, v]) => v.platformMarketing === k)));
check('every declared sequence is a real key',
  MARKETING_TPL.every(([, v]) => E.isSequenceKey(v.platformMarketing)));
check('NO template is both platform marketing and security',
  MARKETING_TPL.every(([, v]) => !v.security),
  'a security message ignores contact preferences; marketing must never borrow that bypass');
check('NO template is both platform marketing and `marketing`',
  MARKETING_TPL.every(([, v]) => !v.marketing),
  '`marketing` means a GARAGE writing to its own customer — a different sender, footer and opt-out list');
// COMPLETENESS FROM THE WHOLE REGISTRY, not from the four: the failure is a TRANSACTIONAL template
// quietly acquiring the flag and so leaving from the marketing domain with the marketing footer.
check('no transactional template has acquired the flag',
  Object.entries(TPLS).filter(([, v]) => v.platformMarketing).every(([k]) => k.startsWith('marketing_')),
  Object.entries(TPLS).filter(([, v]) => v.platformMarketing).map(([k]) => k).join(', '));

console.log('\n— rendered through the real template, not a copy of it —');
const render = (seq, d) => TPLS[`marketing_${seq}`].email(d);
const BASE = { subject: 'Subject here', body: 'First para.\n\nSecond para.', consentSource: 'rep_visit', unsubscribeUrl: 'https://greasedesk.com/u/tok' };
const r1 = render('garage_prospect', BASE);
check('the subject comes from the copy', r1.subject === 'Subject here');
check('a blank subject falls back to something true, never to nothing',
  render('garage_prospect', { ...BASE, subject: '   ' }).subject.length > 5,
  render('garage_prospect', { ...BASE, subject: '   ' }).subject);
check('blank lines become paragraphs', (r1.html.match(/<p>First para\.<\/p>/) && r1.html.match(/<p>Second para\.<\/p>/)) !== null);
check('a single newline becomes a break, not a paragraph',
  /<p>One<br>Two<\/p>/.test(render('garage_prospect', { ...BASE, body: 'One\nTwo' }).html));
check('THE BODY IS ESCAPED',
  !render('garage_prospect', { ...BASE, body: '<script>alert(1)</script>' }).html.includes('<script>')
  && render('garage_prospect', { ...BASE, body: '<script>alert(1)</script>' }).html.includes('&lt;script&gt;'),
  'the one person who types here is the owner, and an escaped body cannot carry a tag into an inbox');
check('  …and so is the subject', !render('garage_prospect', { ...BASE, subject: '<b>x</b>' }).html.includes('<b>x</b>'));
// ASSERTED ON THE LABEL AND THE HREF, not on the button's CSS. A style string is both a worse
// anchor (it changes when somebody restyles the email) and the shape anchored-match-gate rightly
// rejects as a hand-written key matcher.
const withCta = render('garage_prospect', { ...BASE, ctaLabel: 'Read more', ctaUrl: 'https://greasedesk.com/x' }).html;
check('a button when both cta fields are given', withCta.includes('Read more') && withCta.includes('https://greasedesk.com/x'));
check('  …and NONE when only the label is',
  !render('garage_prospect', { ...BASE, ctaLabel: 'Read more' }).html.includes('Read more'),
  'both or neither — a label with no link is not half a button');
check('  …and none when only the link is',
  !render('garage_prospect', { ...BASE, ctaUrl: 'https://greasedesk.com/x' }).html.includes('greasedesk.com/x'));
check('  …and nothing cta-shaped when neither is given',
  !r1.html.includes('Read more') && !r1.html.includes('greasedesk.com/x'));
check('the unsubscribe link is in the body', r1.html.includes('https://greasedesk.com/u/tok'));
check('A MISSING LINK RENDERS A VISIBLE FAULT',
  /UNSUBSCRIBE LINK MISSING/.test(render('garage_prospect', { ...BASE, unsubscribeUrl: '' }).html),
  'lib/notify refuses to send such a body — what matters here is that the omission is LOUD, not tidy');
check('the platform footer is used, not the on-behalf-of-your-garage one',
  r1.html.includes('Sent by GreaseDesk.') && !r1.html.includes('on behalf of your garage'),
  'these four are GreaseDesk writing on its own account, to people with no garage of ours');

console.log('\n— the footer explains the RIGHT reason, per consent source —');
const footers = new Map();
for (const c of E.CONSENT_SOURCES) {
  const h = render('garage_prospect', { ...BASE, consentSource: c }).html;
  const line = (h.match(/You're receiving this because[^<]*/) ?? [''])[0];
  footers.set(c, line);
  check(`${c.padEnd(16)} gets its own sentence`, line.length > 20, line.trim());
}
check('all four are DISTINCT', new Set(footers.values()).size === E.CONSENT_SOURCES.length,
  'the prospecting footer said "you agreed when GreaseDesk visited" — true of one audience, false of three');
check('  …and only the rep one mentions a visit',
  /visited/.test(footers.get('rep_visit')) && !/visited/.test(footers.get('signup'))
  && !/visited/.test(footers.get('waitlist_form')) && !/visited/.test(footers.get('affiliate_terms')));
check('an unrecognised source gets a vague-but-TRUE line, never a wrong specific one',
  /asked to hear from/.test(render('garage_prospect', { ...BASE, consentSource: 'nonsense' }).html)
  && !/visited/.test(render('garage_prospect', { ...BASE, consentSource: 'nonsense' }).html),
  'telling somebody they consented in a way they did not is worse than being vague');
check('the company identity is on every one',
  E.SEQUENCE_KEYS.every((k) => render(k, BASE).html.includes('Company no.')),
  'who is writing, from where — the compliance half of the footer, and not editable');

// ══ 7. WHICH DOMAIN IT LEAVES FROM ══════════════════════════════════════════════════════════════
console.log('\n— the marketing subdomain, and the fact that DNS alone does nothing —');
check('the sender has a SECOND from address', /MARKETING_EMAIL_FROM/.test(mailSrc));
check('it is chosen only when the message says it is marketing',
  /opts\.marketing\s*&&\s*MARKETING_EMAIL_FROM\.trim\(\)\s*\?\s*MARKETING_EMAIL_FROM\.trim\(\)\s*:\s*EMAIL_FROM/.test(mailSrc),
  'one place assembles a From, so there is no second rule');
check('the display-name path uses the SAME chosen address',
  hasKey(mailSrc, 'from', /opts\.fromName/) && /opts\.fromName[\s\S]{0,80}configuredFrom/.test(mailSrc)
  && !/opts\.fromName[\s\S]{0,80}<\$\{bareFrom\}>` : EMAIL_FROM/.test(mailSrc),
  'the branch that renames the sender must not quietly fall back to the apex');
check('unset falls back to the apex rather than failing to send', /MARKETING_EMAIL_FROM = process\.env\.MARKETING_EMAIL_FROM \|\| ''/.test(mailSrc));
check('  …and the fallback is REPORTABLE, not silent',
  /export const marketingFromConfigured/.test(mailSrc) && /export const marketingFromAddress/.test(mailSrc),
  'so nobody turns a sequence on believing the subdomain is in use when it is not');
check('the Engine Room shows which domain it will leave from',
  /onMarketingDomain/.test(prose(src('pages/superadmin/marketing.tsx')))
  && /MARKETING_EMAIL_FROM is not set/.test(src('pages/superadmin/marketing.tsx')),
  'adding the DNS records changes nothing on its own — the screen has to say so');
check('only lib/notify sets marketing: true',
  /tpl\.platformMarketing && channel === 'email'[\s\S]{0,200}marketing: true/.test(notifySrc),
  'from the template\'s own declaration — a caller does not get to choose which reputation to spend');
check('  …and a GARAGE\'S offer to its own customer does NOT take the marketing domain',
  !/tpl\.marketing[\s\S]{0,120}marketing: true/.test(notifySrc),
  'that mail is from the garage, on our apex, and its reputation is already the one it has');
check('the runbook exists and names the Vercel/Resend name mismatch',
  /\.news/.test(src('docs/marketing-subdomain-dns.md')) && /append/.test(src('docs/marketing-subdomain-dns.md')));
check('  …and tells them NOT to widen the apex SPF',
  /Do NOT add Resend/.test(src('docs/marketing-subdomain-dns.md')),
  'the apex record is Microsoft 365\'s and ends in -all deliberately');

// ══ 8. THE WIRING, READ FROM SOURCE ═════════════════════════════════════════════════════════════
console.log('\n— sendNotification asks the right question, in the right order —');
const sendBody = notifySrc.slice(notifySrc.indexOf('export async function sendNotification'));
const iMarketing = sendBody.indexOf('marketingRefusal(');
const iPref = sendBody.indexOf('await isSuppressed(');
const iDemo = sendBody.indexOf('demoSendDecision(');
check('it calls marketingRefusal with the template\'s sequence',
  /marketingRefusal\(args\.recipient, tpl\.platformMarketing\)/.test(sendBody));
check('  …guarded by the template, so no caller can omit it', /if \(tpl\.platformMarketing\) \{/.test(sendBody));
check('the marketing refusal comes BEFORE the contact-preference check',
  iMarketing > 0 && iPref > 0 && iMarketing < iPref,
  'a platform send would otherwise reach isSuppressed, which returns false for every one of them');
check('  …and AFTER the demo block, which must stay first',
  iDemo > 0 && iDemo < iMarketing,
  'the preference check exempts security templates, so a demo check below it would let codes out');
const refusalReturn = sendBody.slice(sendBody.indexOf('if (tpl.platformMarketing)'), sendBody.indexOf('if (tpl.platformMarketing)') + 900);
check('a refusal is recorded as skipped, never as sent',
  hasKey(refusalReturn, 'status', "'skipped'") && hasKey(refusalReturn, 'suppressed', 'true')
  && hasKey(refusalReturn, 'skipCode', 'refusal'),
  'read off the platform-marketing block itself, not off the whole function — the other skips look the same');
check('no_copy is a declared skip code',
  /'no_copy'/.test(notifySrc), 'a step whose words nobody wrote is a named outcome, not a silence');

console.log('\n— the runner: claim, then send, then advance —');
const runner = storeSrc.slice(storeSrc.indexOf('export async function runSequences'));
check('the switch is read before anything is claimed',
  runner.indexOf('await sendingEnabled(') < runner.indexOf('findMany({'),
  'off means nothing is claimed, advanced or stopped — every due enrolment stays exactly as it is');
check('  …and an OFF run reports the number it held',
  /run\.sending = 'off';[\s\S]{0,200}run\.queued = await/.test(runner),
  'a run that sent nothing must say which of the two reasons it is');
check('the step is CLAIMED by a conditional update on the pre-state',
  /updateMany\(\{\s*where: \{ id: e\.id, state: 'active', next_step: e\.next_step, next_due_at: e\.next_due_at \}/.test(runner),
  'so the second of two overlapping runs matches nothing');
check('  …and a run that did not win the claim moves on',
  /if \(claimed\.count !== 1\) continue;/.test(runner));
check('the subject is RE-READ at send time', /const read = await readSubject\(sequence, e\.subject_id, db\);/.test(runner),
  'they may have paid, joined, referred or signed up since the step came due');
check('  …and a subject that says stop, stops', /if \(!read\.ok\) \{ await stop\(read\.stop\); continue; \}/.test(runner));
check('NO COPY HOLDS: it retries, and never advances',
  /if \(!copyIsSendable\(step\)\) \{ run\.heldNoCopy \+= 1; await retry\(\); continue; \}/.test(runner),
  'the clause most likely to be "simplified" by somebody reading the hold as a bug');
check('a failed send retries rather than advancing',
  /await retry\(\);\s*run\.retrying \+= 1;/.test(runner),
  'a step that did not go must never be skipped as if it had');
check('  …and retry puts the claim BACK, rather than leaving the 15-minute lease',
  /const retry = async \(\) => \{[\s\S]{0,220}next_due_at: now/.test(runner));
check('only a successful send advances the step',
  /if \(r\.ok\) \{[\s\S]{0,320}next_step: next\.next_step/.test(runner));
// ORDER, NOT A KEY MATCH: the send must be RECORDED before the stop, or a completed sequence
// loses the date of its own last email.
const elseBranch = runner.slice(runner.indexOf('} else {', runner.indexOf('if (next.state === \'active\')')));
check('the last step stops as completed, having recorded the send FIRST',
  elseBranch.indexOf('last_sent_at: now') > -1
  && elseBranch.indexOf('last_sent_at: now') < elseBranch.indexOf("await stop('completed')"),
  'a completed sequence that forgot its last send date cannot say when it finished');
check('no address is a THIRD outcome, not a failure',
  /if \(!read\.email\) \{ run\.noAddress \+= 1; await retry\(\); continue; \}/.test(runner)
  && hasKey(src('lib/marketing-store.ts'), 'noAddress', /number/),
  'no address to write to / blocked by policy / provider rejected are three different actions');
check('the token is minted once and kept',
  /let token = e\.unsubscribe_token;[\s\S]{0,200}if \(!token\)/.test(runner),
  'so every email in one person\'s sequence carries the same link');

console.log('\n— stopping says why, and cannot be overwritten —');
check('a stop is conditional on the pre-state',
  /updateMany\(\{\s*where: \{ id: enrolmentId, state: 'active' \}/.test(storeSrc),
  'so "unsubscribed" is never later overwritten with "not_eligible"');
const stopBody = storeSrc.slice(storeSrc.indexOf('export async function stopOne'), storeSrc.indexOf('export async function stopFor'));
check('  …and always writes a reason and a time, and clears the due date',
  hasKey(stopBody, 'state', "'stopped'") && hasKey(stopBody, 'stopped_at', 'now')
  && hasKey(stopBody, 'stopped_reason', 'reason') && hasKey(stopBody, 'next_due_at', 'null'),
  'read off stopOne itself — the enum CHECK forbids three of the four being written without the rest');

console.log('\n— one unsubscribe stops all four —');
const unsub = storeSrc.slice(storeSrc.indexOf('export async function unsubscribeByToken'), storeSrc.indexOf('async function stopEverythingFor'));
check('the address goes on the suppression list', /prospectSuppression\.upsert/.test(unsub));
check('  …before any stopping, so a later failure cannot leave it off',
  unsub.indexOf('prospectSuppression.upsert') < unsub.indexOf("stopOne(tx, e.id, 'unsubscribed'"));
check('the clicked enrolment stops', /stopOne\(tx, e\.id, 'unsubscribed', now\)/.test(unsub));
check('  …and so does everything else that address is on', /stopEverythingFor\(address, now, db, e\.id\)/.test(unsub));
check('a prospect\'s personal data is still stripped by the ONE writer that does that',
  /stripPersonal/.test(unsub) && /lib\/prospect-store/.test(unsub),
  'MarketingEnrolment holds no address precisely so that writer stays the only one');
const fanout = storeSrc.slice(storeSrc.indexOf('async function stopEverythingFor'));
for (const t of E.SUBJECT_TYPES) {
  const model = { prospect: 'prospect', group: 'group', affiliate_waitlist: 'affiliateWaitlist', rep: 'rep' }[t];
  check(`the fan-out looks in ${t.padEnd(18)} (${model})`, new RegExp(`db\\.${model}\\.findMany`).test(fanout),
    'enumerated from SUBJECT_TYPES, so a fifth audience without a line here goes red');
}
check('  …and it only stops ACTIVE enrolments', hasKey(fanout, 'state', "'active'"),
  'a stopped one keeps its FIRST reason — an unsubscribe must not overwrite "they signed up"');
check('the endpoint is POST only', /req\.method !== 'POST'/.test(prose(src('pages/api/marketing-unsubscribe.ts'))),
  'mail scanners follow links; opening one must never act');
const postedPath = (src('pages/u/[token].tsx').match(/fetch\(`([^`?]+)/) ?? [])[1] ?? '';
check('  …and the page posts to the renamed endpoint',
  urlUnder(postedPath, '/api/marketing-unsubscribe'),
  postedPath || 'no fetch target found in the page');

console.log('\n— the four adapters, and the one tenant hazard —');
const readSubj = storeSrc.slice(storeSrc.indexOf('export async function readSubject'));
for (const k of E.SEQUENCE_KEYS) {
  check(`readSubject answers for ${k.padEnd(18)}`, new RegExp(`case '${k}':`).test(readSubj));
  check(`  …and can stop it with its own goal (${E.GOAL_STOP[k]})`, hasKey(readSubj, 'stop', `'${E.GOAL_STOP[k]}'`),
    'the SLOW path, asked on every send — a goal hook that was never wired leaves an enrolment running');
}
check('every adapter can report its subject having gone',
  countKey(readSubj, 'stop', "'subject_gone'") === E.SEQUENCE_KEYS.length,
  'there is no foreign key, so a deleted subject is this table\'s to notice');
check('A DEMO OR INTERNAL TENANT IS REFUSED the trial sequence',
  /if \(g\.is_demo \|\| g\.is_internal\) return \{ ok: false, stop: 'not_eligible' \}/.test(readSubj),
  'a PLATFORM send never reaches the demo block in sendNotification — it has no group to check');
check('  …read LIVE, not frozen at enrolment',
  readSubj.indexOf('is_demo') > readSubj.indexOf("case 'trial_garage'"),
  'the flags are set by hand, and the sales demo deliberately has is_demo FALSE so it can text');
check('the trial sequence stops on the first payment column, not on a status guess',
  /g\.billing\?\.first_paid_at/.test(readSubj),
  'written once by the invoice.paid handler, and never overwritten');
check('a suspended affiliate is not encouraged to refer',
  /if \(r\.suspended_at\) return \{ ok: false, stop: 'not_eligible' \}/.test(readSubj),
  'suspension stops NEW attribution, so the thing these emails ask for is the thing they are barred from');
check('the waiting list is joined by ADDRESS, since it holds no link to the Rep',
  /rep\.findFirst\(\{ where: \{ email:/.test(readSubj));
check('prospect eligibility has ONE definition, shared with the rep screens',
  /refuseEnrolment\(p\)/.test(readSubj) && /refuseEnrolment/.test(src('lib/prospects.ts')),
  'the pure predicate stays in lib/prospects; the engine reads it rather than restating it');

console.log('\n— consent is frozen; everything else is read live —');
check('the enrolment carries a source and a date',
  hasKey(storeSrc, 'consent_source', /CONSENT_OF\[opts\.sequence\]/) && hasKey(storeSrc, 'consent_at', /opts\.consentAt/));
check('  …and the date is the CALLER\'S, never now()',
  !hasKey(storeSrc, 'consent_at', 'now'),
  'an enrolment created today for somebody who agreed in August must say August');
check('the source is per-sequence data, so no caller picks it',
  /CONSENT_OF\[opts\.sequence\]/.test(storeSrc) && !hasKey(storeSrc.slice(storeSrc.indexOf('export async function enrol'), storeSrc.indexOf('export async function enrol') + 1800), 'consentSource'),
  'enrol takes no consent SOURCE argument — only the date, which is the part a caller knows');
check('a visit enrols with the prospect\'s recorded consent_at',
  hasKey(prose(src('lib/prospect-store.ts')), 'consentAt', /after\.consent_at/),
  'a visit where nobody asked again leaves the earlier agreement standing — and its date');
check('  …and will not enrol without one', /&& after\.consent_at/.test(prose(src('lib/prospect-store.ts'))));
check('the VISIT commits before the enrolment, not with it',
  prose(src('lib/prospect-store.ts')).indexOf('const prospectId = await db.$transaction')
    < prose(src('lib/prospect-store.ts')).indexOf("enrol({ sequence: 'garage_prospect'"),
  'a recorded visit with no follow-up is a rep\'s work saved; a follow-up with no visit is unexplainable');

console.log('\n— the purge takes the tenant\'s enrolment and nothing else —');
// ── READ OFF THE STATEMENT, NOT OFF THE FILE ──────────────────────────────────────────────────
// This clause was green against a mutation that gutted the sweep's WHERE, because the same scope
// literal also appears on the COUNT one screen up: `/sequence_key: 'trial_garage', …/.test(purgeSrc)`
// matched the count while the delete swept the whole table. One pattern, two subjects — so each
// statement is sliced out and asked about itself. Caught by a real mutation, 2026-11-02.
const stmt = (haystack, needle) => {
  const i = haystack.indexOf(needle);
  if (i < 0) return null;
  const end = haystack.indexOf(';', i);
  return end < 0 ? null : haystack.slice(i, end + 1);
};
const sweepStmt = stmt(purgeSrc, 'marketingEnrolment.deleteMany');
const countStmt = stmt(purgeSrc, 'marketingEnrolment.count');
check('the purge sweeps MarketingEnrolment', sweepStmt !== null,
  'no foreign key to Group, so the cascade never sees it');
check('  …and the DELETE statement itself is scoped to the group subject type',
  !!sweepStmt && hasKey(sweepStmt, 'sequence_key', "'trial_garage'") && hasKey(sweepStmt, 'subject_type', "'group'")
  && hasKey(sweepStmt, 'subject_id', 'groupId'),
  (sweepStmt ?? 'no statement found').replace(/\s+/g, ' ').slice(0, 120));
check('  …inside the same transaction as the rest', purgeSrc.indexOf('marketingEnrolment.deleteMany') < purgeSrc.lastIndexOf('tx.group.delete'));
check('  …and it is COUNTED, before and after', hasKey(purgeSrc, 'MarketingEnrolment', 'marketingEnrolments'),
  'counting is how we know it went; the sweep is only how');
check('  …with the COUNT scoped identically, or the after-count lies',
  !!countStmt && hasKey(countStmt, 'sequence_key', "'trial_garage'") && hasKey(countStmt, 'subject_type', "'group'"),
  'a count narrower or wider than the sweep reports zero for the wrong reason');
check('the manifest classifies all four new tables',
  ['MarketingEnrolment', 'MarketingSending', 'MarketingSendingLease', 'MarketingCopy']
    .every((m) => new RegExp(`^\\s*${m}:`, 'm').test(src('lib/tenant-manifest.ts'))));

console.log('\n— one job, not four; one switch, not two —');
check('the cron is registered', /"\/api\/cron\/marketing-sequences"/.test(src('vercel.json')));
check('  …and the retired one is gone', !/prospect-sequence/.test(src('vercel.json')));
check('the cron runs every sequence', /runSequences\(\{ now \}\)/.test(prose(src('pages/api/cron/marketing-sequences.ts'))));
check('  …and is CRON_SECRET guarded', /req\.headers\.authorization !== `Bearer \$\{secret\}`/.test(src('pages/api/cron/marketing-sequences.ts')));
// ASSERTED AS "THIS SCREEN WRITES NOTHING", which is the real property and needs no path literal.
// The switch was its only write; counting fetches is also not vacuous, where testing for the
// absence of one retired URL would silently pass a page that had grown a different write.
const prospectPage = prose(src('pages/superadmin/prospects.tsx'));
check('the prospect screen no longer carries its own switch',
  (prospectPage.match(/fetch\(/g) ?? []).length === 0,
  'it is a read-only list now — two places to turn one sequence on is how one of them shows a stale answer');
const switchHref = (src('pages/superadmin/prospects.tsx').match(/href="(\/superadmin\/[a-z-]+)"[^>]*er-sending-link/s) ?? [])[1] ?? '';
check('  …and points at the one place it can be changed',
  urlUnder(switchHref, '/superadmin/marketing'), switchHref || 'no link found on the sending panel');
check('the Engine Room screen is owner-only in the nav',
  /'\/superadmin\/marketing', label: 'Marketing', minRole: 'owner'/.test(src('lib/operator-roles.ts')),
  'erMinRole falls back to support for an unregistered href, so a missing line would open it to the lowest role');
check('  …and the API enforces owner independently of the nav',
  /roleAtLeast\(op\.role, 'owner'\)/.test(prose(src('pages/api/superadmin/marketing.ts'))));
check('  …refusing with 404, not 403', /return res\.status\(404\)\.json\(\{ message: 'Not found\.' \}\)/.test(prose(src('pages/api/superadmin/marketing.ts'))),
  'an operator who may not do this must not learn the thing exists');
check('a switch change is audited in the same transaction as the switch',
  /superAdminAudit\.create[\s\S]{0,400}activeEnrolmentsAtChange/.test(storeSrc),
  '"I switched it on" and "I switched it on and 340 emails went out" are different events');
check('the preview renders through the REAL template',
  /NOTIFICATION_TEMPLATES/.test(storeSrc) && /tpl\.email\(\{/.test(storeSrc),
  'a preview assembled beside the thing it previews agrees with itself and proves nothing');
check('  …and its unsubscribe link cannot suppress a real address',
  /#preview-unsubscribe-link/.test(storeSrc),
  'a preview must show the way out is there, and must not mint a working one');
check('the test send goes through sendNotification, so it is logged and suppressed like any other',
  /export async function sendTest[\s\S]{0,1600}await sendNotification\(/.test(storeSrc));
check('  …and does NOT consult the sequence\'s switch',
  !/export async function sendTest[\s\S]{0,1600}sendingEnabled\(/.test(storeSrc),
  'the whole point is reading the email before turning the sequence on');
check('the screen clears its busy flag in `finally`',
  /} finally \{[\s\S]{0,300}setBusy\(false\);/.test(src('pages/superadmin/marketing.tsx')),
  'a busy flag left set by a thrown fetch disables the only button that could retry it');

// ══ 9. RED-PROOFS ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— the scans find a planted case and reject a broken one —');
check('RP1 a pair CHECK missing one audience would be caught',
  (() => { const broken = pairChk.replace(/\("sequence_key" = 'trial_garage'[^)]*\)\s*OR\s*/, '');
    return !/trial_garage/.test(broken) && /trial_garage/.test(pairChk); })(),
  'the per-pair clauses read the SQL, so a dropped line goes red rather than passing on the other three');
check('RP2 REFUSE_IF_CUSTOMER flipped "for symmetry" would be caught',
  (() => { const broken = { ...E.REFUSE_IF_CUSTOMER, trial_garage: true };
    return Object.values(broken).filter(Boolean).length !== 1
      && Object.values(E.REFUSE_IF_CUSTOMER).filter(Boolean).length === 1; })(),
  'asserted as a COUNT, which is what a second `true` breaks');
check('RP3 the no-copy hold rejected as a bug would be caught',
  (() => { const broken = runner.replace(
    /if \(!copyIsSendable\(step\)\) \{ run\.heldNoCopy \+= 1; await retry\(\); continue; \}/,
    'if (!copyIsSendable(step)) { continue; }');
    return !/heldNoCopy \+= 1; await retry\(\)/.test(broken) && /heldNoCopy \+= 1; await retry\(\)/.test(runner); })(),
  'a bare `continue` leaves the 15-minute claim on the row, so the step silently waits a quarter hour');
check('RP4 an escape removed from the body renderer would be caught',
  render('garage_prospect', { ...BASE, body: '<i>x</i>' }).html.includes('&lt;i&gt;')
  && !render('garage_prospect', { ...BASE, body: '<i>x</i>' }).html.includes('<i>x</i>'),
  'asserted both ways: the escaped form present AND the raw form absent');
check('RP5 one footer sentence copy-pasted onto another source would be caught',
  (() => { const broken = new Map(footers); broken.set('signup', footers.get('rep_visit'));
    return new Set(broken.values()).size !== E.CONSENT_SOURCES.length
      && new Set(footers.values()).size === E.CONSENT_SOURCES.length; })(),
  'the distinctness clause is what fails on a copy-paste');
check('RP6 a fifth sequence added without a label would be caught',
  (() => { const keys = [...E.SEQUENCE_KEYS, 'a_fifth_nobody_labelled'];
    return !keys.every((k) => k in E.SEQUENCE_LABEL) && E.SEQUENCE_KEYS.every((k) => k in E.SEQUENCE_LABEL); })(),
  'completeness is enumerated from SEQUENCE_KEYS, so the array and the maps cannot drift apart');
check('RP7 the purge sweep widened past the group subject would be caught',
  (() => { const broken = "await tx.marketingEnrolment.deleteMany({ where: { subject_id: groupId } });";
    // ASKED OF THE STATEMENT, as the clause above now is. The earlier version of this red-proof
    // tested `purgeSrc` and so agreed with the count rather than the delete — it passed while the
    // real mutation went green, which is the definition of a proof that proved nothing.
    return !hasKey(stmt(broken, 'marketingEnrolment.deleteMany') ?? '', 'subject_type', "'group'")
      && hasKey(sweepStmt ?? '', 'subject_type', "'group'"); })(),
  'a sweep keyed on subject_id alone would delete another audience\'s row that happened to share a uuid');
check('RP8 a transactional template acquiring the marketing flag would be caught',
  (() => { const broken = { ...TPLS, invoice_issued: { ...TPLS.invoice_issued, platformMarketing: 'trial_garage' } };
    return !Object.entries(broken).filter(([, v]) => v.platformMarketing).every(([k]) => k.startsWith('marketing_'))
      && Object.entries(TPLS).filter(([, v]) => v.platformMarketing).every(([k]) => k.startsWith('marketing_')); })(),
  'enumerated over the WHOLE registry, not over the four — the flag decides the From domain and the footer');
check('RP9 the parsers are not vacuous',
  (sqlColumns('MarketingEnrolment')?.size ?? 0) > 0 && sqlColumns('NoSuchTable') === null
  && (schemaFields('MarketingCopy')?.size ?? 0) > 0 && schemaFields('NoSuchModel') === null,
  'a scan that silently matched nothing would make every clause in §1 pass over empty sets');

// ── VERDICT ─────────────────────────────────────────────────────────────────────────────────────
const failed = out.filter((r) => r === 'F').length;
console.log(`\n${failed} failures of ${out.length}`);
process.exit(failed ? 1 : 0);
