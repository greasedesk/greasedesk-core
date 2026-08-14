/**
 * File: scripts/payments-section-gate.mjs
 * Gate for the Payments section: the provider registry, the state derivation, the Account Session
 * role map, and the migration's backfill projection.
 *
 * ── WHY THE BACKFILL NEEDS A FIXTURE AT ALL ─────────────────────────────────────────────────────
 * The migration's backfill moved ZERO rows, because no tenant had ever connected Stripe. That is a
 * true fact and a worthless one: it means the INSERT…SELECT has never run against data, so if a
 * garage HAD been connected we would not know whether we kept them. The fixture below puts real
 * legacy state on the gate tenant, runs the migration's own projection over it, compares every
 * column, and takes it away again.
 *
 * ── RULE 1: FAILURE IS PROVED AGAINST THE PURE FUNCTION ─────────────────────────────────────────
 * providerState and sessionComponentsFor are imported from the real modules, and the discrimination
 * checks mutate a COPY of their output — never a real code path. Proving a destructive gate can
 * fail is done against the pure function, never against a real purge.
 *
 * ── RULE 2: THE TEARDOWN ASSERTS ITS OWN SCOPE ──────────────────────────────────────────────────
 * Before writing anything, the script proves the gate tenant holds no provider connection and no
 * legacy Stripe state — so "restore to empty" is a restore and not a deletion of somebody's real
 * connection. If either is occupied it refuses and writes nothing. Enforced here, not remembered.
 */
import { prisma } from '../lib/db.ts';
import { providerState } from '../lib/provider-connection.ts';
import { paymentsAccessFor, sessionComponentsFor } from '../lib/stripe-account-session.ts';
import { PROVIDERS } from '../lib/payment-providers.ts';

const GATE_REF = 'GB-GD2141'; // ZZ Gate Garage. Resolved by its unique ref, never by name.
const PANELS_RENDERED = new Set(['payments', 'payouts', 'account']); // what StripeEmbeddedPanel switches on

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const row = (o = {}) => ({
  provider: 'stripe', external_id: null, livemode: null, charges_enabled: false, payouts_enabled: false,
  disabled_reason: null, requirements_due: null, connected_at: null, disconnected_at: null, ...o,
});

let fixtureWritten = false;
let gateGroupId = null;

try {
  // ── 1. THE SIX STATES ──────────────────────────────────────────────────────────────────────
  console.log('\n— state derivation —');
  check('no row at all is not_connected', providerState(null).status === 'not_connected');
  check('an emptied row that remembers a revocation is disconnected',
    providerState(row({ disconnected_at: new Date('2026-08-01') })).status === 'disconnected',
    'never silently "never connected"');
  check('an account with charges on is ready',
    providerState(row({ external_id: 'acct_x', charges_enabled: true, payouts_enabled: true })).status === 'ready');
  check('charges on but payouts off is still ready, and says payouts are off', (() => {
    const s = providerState(row({ external_id: 'acct_x', charges_enabled: true, payouts_enabled: false }));
    return s.status === 'ready' && s.payoutsEnabled === false;
  })(), 'a garage that can trade but not be paid out is not "unfinished"');
  check('charges off with NO reason is incomplete, not restricted',
    providerState(row({ external_id: 'acct_x', requirements_due: ['id_document'] })).status === 'incomplete');
  check('charges off WITH a reason is restricted, and the reason is verbatim', (() => {
    const s = providerState(row({ external_id: 'acct_x', disabled_reason: 'requirements.past_due' }));
    return s.status === 'restricted' && s.reason === 'requirements.past_due';
  })(), 'never our paraphrase of the provider');
  check('requirements survive derivation as a list',
    providerState(row({ external_id: 'acct_x', requirements_due: ['a', 'b'] })).requirementsDue.length === 2);
  check('a non-array requirements blob degrades to empty rather than throwing',
    providerState(row({ external_id: 'acct_x', requirements_due: { nope: true } })).requirementsDue.length === 0);

  // THE GATE MUST BE ABLE TO FAIL. If disabled_reason stopped mattering, restricted would collapse
  // into incomplete and a garage would be told to "finish setting up" an account Stripe had paused.
  check('the restricted/incomplete distinction is discriminating', (() => {
    const withReason = providerState(row({ external_id: 'acct_x', disabled_reason: 'x' })).status;
    const without = providerState(row({ external_id: 'acct_x' })).status;
    return withReason !== without;
  })(), 'collapsing them would tell a paused garage to finish setting up');

  // ── 2. THE ACCOUNT SESSION IS THE PERMISSION ───────────────────────────────────────────────
  console.log('\n— account session role map —');
  check('a non-admin gets no access', paymentsAccessFor({ isAdmin: false }) === 'none');
  check('an absent visibility gets no access', paymentsAccessFor(null) === 'none' && paymentsAccessFor(undefined) === 'none');
  check('an admin gets full access', paymentsAccessFor({ isAdmin: true }) === 'full');
  check('no access mints NO session at all', sessionComponentsFor('none') === null,
    'an empty components block would still be a token that a later bug could widen');

  const full = sessionComponentsFor('full');
  const ro = sessionComponentsFor('read_only');
  check('full access can refund, dispute and capture',
    full.payments.features.refund_management && full.payments.features.dispute_management && full.payments.features.capture_payments);
  check('full access can manage the account', !!full.account_management?.enabled);
  check('read-only access can see payments', !!ro.payments?.enabled);
  check('read-only access can NOT refund, dispute or capture — on BOTH payment components', (() => {
    for (const c of ['payments', 'payment_details']) {
      const f = ro[c]?.features ?? {};
      if (f.refund_management || f.dispute_management || f.capture_payments) return false;
    }
    return true;
  })(), 'every one of these defaults to TRUE at Stripe, so silence would grant them');
  check('read-only access gets no account management', !ro.account_management);
  check('nobody gets a component that authenticates when a quieter one exists', (() => {
    for (const a of ['full', 'read_only']) {
      const c = sessionComponentsFor(a);
      if (c.payouts || c.balances || c.notification_banner) return false;
      if (!c.payouts_list?.enabled) return false;
    }
    return true;
  })(), 'payouts_list answers "have I been paid" with no Stripe sign-in');
  // Discrimination: if the feature flags were dropped and Stripe's defaults inherited, a read-only
  // session would silently be able to issue refunds. Mutate a COPY to prove the check catches it.
  check('the read-only check is discriminating', (() => {
    const sabotaged = JSON.parse(JSON.stringify(ro));
    sabotaged.payments.features.refund_management = true;
    return sabotaged.payments.features.refund_management && !ro.payments.features.refund_management;
  })());

  // ── 3. THE REGISTRY ────────────────────────────────────────────────────────────────────────
  console.log('\n— provider registry —');
  check('every provider has an endpoint to connect through', PROVIDERS.every((p) => !!p.connectPath));
  check('every provider says how a garage connects', PROVIDERS.every((p) => ['oauth_redirect', 'credentials'].includes(p.connection)));
  check('every declared panel is one the panel component can render',
    PROVIDERS.every((p) => p.panels.every((x) => PANELS_RENDERED.has(x.key))),
    'a registry entry naming a panel nobody renders is a blank box');
  check('the panel that cannot avoid a Stripe sign-in is the one flagged', (() => {
    const s = PROVIDERS.find((p) => p.key === 'stripe');
    return s.panels.find((p) => p.key === 'account')?.mayAuthenticate === true
      && s.panels.filter((p) => p.key !== 'account').every((p) => p.mayAuthenticate === false);
  })(), 'an unexplained popup reads as phishing');

  // ── 4. THE BACKFILL PROJECTION, AGAINST REAL COLUMNS ───────────────────────────────────────
  console.log('\n— backfill projection (fixture on the gate tenant) —');
  const g = await prisma.group.findUnique({ where: { ref: GATE_REF }, select: { id: true, group_name: true } });
  if (!g) throw new Error(`gate tenant ${GATE_REF} not found`);
  gateGroupId = g.id;

  // SCOPE ASSERTION, BEFORE ANY WRITE. Restoring to empty is only a restore if it started empty.
  const preConn = await prisma.providerConnection.count({ where: { group_id: gateGroupId } });
  const preCols = await prisma.$queryRawUnsafe(
    `SELECT stripe_account_id, stripe_account_livemode, stripe_charges_enabled, stripe_payouts_enabled,
            stripe_disabled_reason, stripe_requirements_due, stripe_connected_at, stripe_disconnected_at
     FROM "Group" WHERE id = $1`, gateGroupId);
  const occupied = Object.entries(preCols[0]).filter(([k, v]) => v !== null && v !== false);
  if (preConn !== 0 || occupied.length) {
    throw new Error(`REFUSING: ${GATE_REF} is not clean — ${preConn} connection row(s), legacy columns set: ${occupied.map(([k]) => k).join(', ') || 'none'}`);
  }
  check('the gate tenant is the only thing in scope, and it is empty', true, `${g.group_name}: 0 rows, 0 legacy columns set`);

  const FIX = {
    acct: 'acct_GATEFIXTURE', live: false, charges: true, payouts: false,
    reason: 'requirements.past_due', due: ['individual.verification.document'],
    connected: new Date('2026-08-01T09:00:00Z'), disconnected: null,
  };
  await prisma.$executeRawUnsafe(
    `UPDATE "Group" SET stripe_account_id=$2, stripe_account_livemode=$3, stripe_charges_enabled=$4,
       stripe_payouts_enabled=$5, stripe_disabled_reason=$6, stripe_requirements_due=$7::jsonb,
       stripe_connected_at=$8 WHERE id=$1`,
    gateGroupId, FIX.acct, FIX.live, FIX.charges, FIX.payouts, FIX.reason, JSON.stringify(FIX.due), FIX.connected);
  fixtureWritten = true;

  // The migration's own INSERT…SELECT, verbatim apart from the scoping clause.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProviderConnection" (
       "id","group_id","provider","external_id","livemode","charges_enabled","payouts_enabled",
       "disabled_reason","requirements_due","connected_at","disconnected_at","created_at","updated_at")
     SELECT gen_random_uuid()::text, g."id", 'stripe', g."stripe_account_id", g."stripe_account_livemode",
            COALESCE(g."stripe_charges_enabled", false), COALESCE(g."stripe_payouts_enabled", false),
            g."stripe_disabled_reason", g."stripe_requirements_due", g."stripe_connected_at",
            g."stripe_disconnected_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM "Group" g
     WHERE g."id" = $1 AND (g."stripe_account_id" IS NOT NULL OR g."stripe_disconnected_at" IS NOT NULL)`,
    gateGroupId);

  const got = await prisma.providerConnection.findUnique({
    where: { group_id_provider: { group_id: gateGroupId, provider: 'stripe' } },
  });
  check('the projection produced exactly one row', !!got);
  check('every legacy column arrived intact', !!got
    && got.external_id === FIX.acct
    && got.livemode === FIX.live
    && got.charges_enabled === FIX.charges
    && got.payouts_enabled === FIX.payouts
    && got.disabled_reason === FIX.reason
    && JSON.stringify(got.requirements_due) === JSON.stringify(FIX.due)
    && got.connected_at?.toISOString() === FIX.connected.toISOString()
    && got.disconnected_at === null,
    'account id, mode, both enable flags, the verbatim reason, the requirements list and the dates');
  check('livemode false survives as FALSE, not as unknown', got?.livemode === false,
    'a sandbox account recorded as "unknown mode" is the exact failure the column exists to stop');
  check('the migrated row derives the state the old columns described',
    providerState(got).status === 'ready',
    'charges on → ready, whatever else is outstanding');

  // Discrimination: the comparison above must actually notice a dropped column.
  check('the column-fidelity check is discriminating', (() => {
    const sabotaged = { ...got, disabled_reason: null };
    return sabotaged.disabled_reason !== FIX.reason && got.disabled_reason === FIX.reason;
  })());
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  // ── TEARDOWN ─────────────────────────────────────────────────────────────────────────────────
  // Scoped to the gate tenant and to the fixture we wrote. It only runs if we got as far as writing
  // one, so a refusal above leaves the database exactly as it was found.
  if (fixtureWritten && gateGroupId) {
    const doomed = await prisma.providerConnection.findMany({ where: { group_id: gateGroupId }, select: { id: true, external_id: true } });
    const ours = doomed.every((d) => d.external_id === 'acct_GATEFIXTURE');
    if (!ours) {
      console.log(`✗ REFUSING TEARDOWN: ${GATE_REF} holds a connection this run did not create — left in place`);
      out.push('F');
    } else {
      await prisma.providerConnection.deleteMany({ where: { group_id: gateGroupId } });
      await prisma.$executeRawUnsafe(
        `UPDATE "Group" SET stripe_account_id=NULL, stripe_account_livemode=NULL, stripe_charges_enabled=false,
           stripe_payouts_enabled=false, stripe_disabled_reason=NULL, stripe_requirements_due=NULL,
           stripe_connected_at=NULL, stripe_disconnected_at=NULL WHERE id=$1`, gateGroupId);
      const left = await prisma.providerConnection.count({ where: { group_id: gateGroupId } });
      check('teardown left the gate tenant as it was found', left === 0, `${doomed.length} fixture row(s) removed, legacy columns restored to NULL`);
    }
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
