/**
 * File: scripts/clear-tmbs-free-flag.mjs
 * CLEAR ONE TENANT'S FREE DECISION — the record of what ran, kept because it ran against production
 * data and because free_since and free_reason exist nowhere else once they are gone.
 *
 * ── WHAT HAPPENED, IN ORDER ─────────────────────────────────────────────────────────────────────
 *   5 Sep 15:48  GB-GD1967 set free. "Owner-operated garage — the product is built here."
 *   6 Sep 07:25  Its stranded Stripe pointers were nulled (ids from the platform account retired on
 *                6 August, which nothing could refresh). Correct in itself.
 *   6 Sep 07:52  A real subscription was taken: sub_1UCatB… on the CURRENT account, trialing,
 *                first charge 5 November.
 *
 * The clear at 07:25 removed the stale `trialing` that had been satisfying onboarding step (F), so
 * the root gate began redirecting every admin page to Checkout and the product was unreachable
 * without paying. The card was added 27 minutes later. The free decision was overtaken by that
 * subscription, and this removes it.
 *
 * ── WHY THE FLAG MUST GO RATHER THAN BE LEFT HARMLESS ───────────────────────────────────────────
 * It is not harmless. Once the free-blind readers were fixed, `free_since` on a tenant with a live
 * subscription does two wrong things at once:
 *   · refuseDemoBilling refuses /api/stripe/portal, so "Manage billing" answers "This is a demo
 *     garage" and the owner cannot reach the card they just entered;
 *   · the dashboard banner returns null, so nothing says a charge lands on 5 November — against the
 *     standing ruling that a customer is never surprised by a charge.
 * Free and subscribed are mutually exclusive, and nothing in the codebase notices. See the report.
 *
 * ── THE AUDIT ROW IS WRITTEN FIRST, AND READ BACK, BEFORE ANYTHING IS CLEARED ───────────────────
 * Afterwards that row is the only record that this tenant was ever free, and of the reason somebody
 * wrote. A failed audit write aborts the clear rather than proceeding without the record — the same
 * ordering as clear-stranded-subscriptions, for the same reason.
 *
 * ── REFUSALS ────────────────────────────────────────────────────────────────────────────────────
 * Resolved by ref, never by name. Refuses if the tenant is not free (nothing to clear). Refuses if
 * there is NO live subscription — the justification written into the audit row is that a
 * subscription overtook the decision, and a script must not record a reason it has not checked.
 */
import './_gate-preflight.mjs';
const { gatePrisma } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const prisma = await gatePrisma();

const OPERATOR_ID = 'acab39ee-aea8-4ae8-b855-312007bebdb2'; // hugh@greasedesk.com, owner
const SUBJECT = 'GB-GD1967';
const LIVE = new Set(['trialing', 'active', 'past_due']);
const REASON = 'Free decision of 5 September 2026 overtaken by a real subscription taken on 6 September 2026 '
  + '(sub on the current platform account, trialing, first charge 5 November). Free and subscribed are mutually '
  + 'exclusive: leaving the flag set refused this tenant its own Stripe portal and silenced the charge notice. '
  + 'Previous free_since and free_reason preserved in this row. Run by script on the owner\'s instruction.';

const dry = !process.argv.includes('--commit');
console.log(dry ? '— DRY RUN. Pass --commit to write. —\n' : '— COMMITTING —\n');

const g = await prisma.group.findFirst({
  where: { ref: SUBJECT },
  select: { id: true, ref: true, group_name: true, free_since: true, free_reason: true, is_internal: true, is_demo: true,
    billing: { select: { subscription_status: true, stripe_customer_id: true, stripe_subscription_id: true } } },
});
if (!g) { console.log(`${SUBJECT}  NOT FOUND — nothing done`); await prisma.$disconnect(); process.exit(1); }

const b = g.billing;
console.log(`${g.ref}  ${g.group_name}`);
console.log(`   before: free_since=${g.free_since?.toISOString() ?? 'null'}  is_internal=${g.is_internal}  is_demo=${g.is_demo}`);
console.log(`   reason: ${g.free_reason ?? '(none)'}`);
console.log(`   billing: status=${b?.subscription_status ?? 'null'}  sub=${b?.stripe_subscription_id ?? 'null'}  cus=${b?.stripe_customer_id ?? 'null'}`);

if (!g.free_since) {
  console.log('\n   REFUSED: not free. Nothing to clear.');
} else if (!LIVE.has(b?.subscription_status ?? '')) {
  console.log(`\n   REFUSED: no live subscription (status=${b?.subscription_status ?? 'null'}). The reason this script`);
  console.log('   records is that a subscription overtook the decision, and that is not true here.');
} else if (dry) {
  console.log('\n   would write a SuperAdminAudit row carrying free_since + free_reason, then null both');
} else {
  // ── THE RECORD FIRST. Not caught: if this fails, nothing is cleared. ────────────────────────
  const audit = await prisma.superAdminAudit.create({
    data: {
      operator_user_id: OPERATOR_ID,
      action: 'tenant.free_flag_cleared',
      target_group_id: g.id, target_operator_id: null,
      target_name_snapshot: g.group_name,
      target_ref_snapshot: g.ref == null ? null : String(g.ref),
      reason: REASON,
      detail: {
        freeSince: g.free_since.toISOString(),
        freeReason: g.free_reason,
        subscriptionStatus: b?.subscription_status ?? null,
        stripeSubscriptionId: b?.stripe_subscription_id ?? null,
        stripeCustomerId: b?.stripe_customer_id ?? null,
      },
    },
    select: { id: true },
  });
  // READ IT BACK. This row is the only surviving record that the tenant was ever free.
  const back = await prisma.superAdminAudit.findUnique({ where: { id: audit.id }, select: { detail: true } });
  const kept = (back?.detail ?? {}).freeSince;
  if (kept !== g.free_since.toISOString()) {
    throw new Error(`REFUSING to clear ${g.ref}: the audit row does not carry free_since back (${kept})`);
  }
  console.log(`\n   audit ${audit.id} written and read back, carrying ${kept}`);

  const after = await prisma.group.update({
    where: { id: g.id },
    data: { free_since: null, free_reason: null },
    select: { free_since: true, free_reason: true, is_internal: true, is_demo: true },
  });
  console.log(`   after:  free_since=${after.free_since ?? 'null'}  free_reason=${after.free_reason ?? 'null'}  is_internal=${after.is_internal} (untouched)  is_demo=${after.is_demo} (untouched)`);
}

await prisma.$disconnect();
