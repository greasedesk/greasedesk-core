/**
 * File: scripts/clear-stranded-subscriptions.mjs
 * CLEAR TWO STRANDED STRIPE POINTERS — the record of what ran, kept because it ran against
 * production data and because the ids it removes exist nowhere else afterwards.
 *
 * ── WHAT WAS STRANDED ───────────────────────────────────────────────────────────────────────────
 *   GB-GD1967  The Mini & BMW Specialist   sub_1Ttj1FRjwVlkKDCtyU9jhwj2 / cus_UtW118Edj7ruAq
 *   US-GD2175  ZZUS Motors                 sub_1Typi8RjwVlkKDCtWfTbSWA9 / cus_UynIZQWP7j3Fwh
 *
 * Both carry the account fragment `RjwVlkKDCt` — the platform's PREVIOUS Stripe account, whose
 * webhook traffic runs 14 July to 6 August 2026 and then stops dead. The current account
 * (`Du8OXvJikw`) picks up on 7 August without a gap. Nothing has been able to refresh these two
 * rows since the cutover, so `subscription_status: 'trialing'` is a claim about an object the
 * platform cannot see.
 *
 * NOT the garage's own account. TMBS's connected account is `acct_1U4cjoReZSnKwwOj`, and its
 * webhook traffic is Connect-shaped throughout — account.updated, payment_intent.succeeded,
 * payout.paid, and ZERO subscription events ever. The two accounts have never touched each other.
 *
 * ── WHY NULL AND NOT A CORRECTION ───────────────────────────────────────────────────────────────
 * These columns are documented as "a mirror written ONLY by verified webhook handlers". A mirror of
 * an object nothing can refresh should be empty; an id nothing can refresh is a fossil, and a value
 * that looks live and isn't is worse than an absent one. NULL is also what the gate already treats
 * correctly: canWrite returns true for no subscription, and billingGate has no anchor so the phase
 * stays `ok`. Both tenants are `free` besides, so the banner is silent either way.
 *
 * ── THE AUDIT ROW IS WRITTEN FIRST, AND VERIFIED, BEFORE ANYTHING IS CLEARED ────────────────────
 * After this runs, that row is the ONLY remaining record of what these two tenants pointed at. So
 * it is written, READ BACK, and only then are the columns nulled — a failed audit write aborts the
 * clear rather than proceeding without the record. Doing it the other way round would be a
 * destructive act whose receipt might not exist.
 *
 * ── WHAT THIS SCRIPT DOES NOT KNOW ──────────────────────────────────────────────────────────────
 * Whether those subscriptions still exist, or are still active, in the old account. STRIPE_SECRET_KEY
 * is not on the machine this ran from, and the key it would need belongs to an account the platform
 * no longer holds. Run on the owner's instruction and on the owner's own check of that account —
 * the reason recorded below says so rather than implying the script verified it.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const prisma = await gatePrisma();

/** The acting operator. SuperAdminAudit.operator_user_id is required; the reason says how it ran. */
const OPERATOR_ID = 'acab39ee-aea8-4ae8-b855-312007bebdb2'; // hugh@greasedesk.com, owner
const REASON = 'Stranded pointer cleared: the subscription does not exist in any Stripe account we hold '
  + '(it belongs to the platform account retired on 6 August 2026, not to the garage\'s connected account). '
  + 'Both tenants are now free. Old ids preserved in this row. Run by script on the owner\'s instruction.';
const SUBJECTS = ['GB-GD1967', 'US-GD2175'];

const dry = !process.argv.includes('--commit');
console.log(dry ? '— DRY RUN. Pass --commit to write. —\n' : '— COMMITTING —\n');

for (const ref of SUBJECTS) {
  const g = await prisma.group.findFirst({
    where: { ref },
    select: { id: true, ref: true, group_name: true, free_since: true,
      billing: { select: { stripe_subscription_id: true, stripe_customer_id: true, subscription_status: true, status: true } } },
  });
  if (!g) { console.log(`${ref}  NOT FOUND — nothing done\n`); continue; }
  const b = g.billing;
  console.log(`${g.ref}  ${g.group_name}`);
  console.log(`   before: sub=${b?.stripe_subscription_id ?? 'null'}  cus=${b?.stripe_customer_id ?? 'null'}  stripeStatus=${b?.subscription_status ?? 'null'}  ourStatus=${b?.status}`);
  console.log(`   free_since=${g.free_since?.toISOString() ?? 'null'}`);

  if (!b) { console.log('   no billing row — nothing to clear\n'); continue; }
  if (!b.stripe_subscription_id && !b.stripe_customer_id && !b.subscription_status) {
    console.log('   already clear — nothing done\n'); continue;
  }
  if (dry) { console.log('   would write a SuperAdminAudit row carrying those ids, then null all three\n'); continue; }

  // ── THE RECORD FIRST. Not caught: if this fails, nothing is cleared. ────────────────────────
  const audit = await prisma.superAdminAudit.create({
    data: {
      operator_user_id: OPERATOR_ID,
      action: 'tenant.stripe_pointer_cleared',
      target_group_id: g.id, target_operator_id: null,
      target_name_snapshot: g.group_name,
      target_ref_snapshot: g.ref == null ? null : String(g.ref),
      reason: REASON,
      detail: {
        stripeSubscriptionId: b.stripe_subscription_id,
        stripeCustomerId: b.stripe_customer_id,
        subscriptionStatus: b.subscription_status,
        ourStatus: b.status,
        retiredAccountFragment: 'RjwVlkKDCt',
        connectedAccountUnaffected: 'acct_1U4cjoReZSnKwwOj (TMBS Connect; never held a subscription)',
      },
    },
    select: { id: true },
  });
  // READ IT BACK. The row is the only surviving copy of the ids about to be removed.
  const back = await prisma.superAdminAudit.findUnique({ where: { id: audit.id }, select: { detail: true } });
  const kept = (back?.detail ?? {}).stripeSubscriptionId;
  if (kept !== b.stripe_subscription_id) {
    throw new Error(`REFUSING to clear ${g.ref}: the audit row does not carry the id back (${kept})`);
  }
  console.log(`   audit ${audit.id} written and read back, carrying ${kept}`);

  await prisma.groupBilling.update({
    where: { group_id: g.id },
    data: { stripe_subscription_id: null, stripe_customer_id: null, subscription_status: null },
  });
  const after = await prisma.groupBilling.findUnique({
    where: { group_id: g.id },
    select: { stripe_subscription_id: true, stripe_customer_id: true, subscription_status: true, status: true, grace_started_at: true },
  });
  console.log(`   after:  sub=${after?.stripe_subscription_id ?? 'null'}  cus=${after?.stripe_customer_id ?? 'null'}  stripeStatus=${after?.subscription_status ?? 'null'}  ourStatus=${after?.status} (untouched)\n`);
}

await prisma.$disconnect();
