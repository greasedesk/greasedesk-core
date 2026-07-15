/**
 * File: pages/api/cron/onboard-proof.ts  — TEMPORARY (item-13 acceptance). DELETE after proof.
 * CRON_SECRET-guarded. Walks a throwaway ZZ tenant through every onboarding state and asserts the
 * root gate routes correctly at each: site → rates → tax → checkout → onboarded. Then creates a REAL
 * sandbox Stripe trial and asserts completion flips live off Stripe's truth (the synchronous-confirm
 * cache write) and that trial_ends_at comes from Stripe. Purges the ZZ tenant at the end. TMBS untouched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getStripe, stripePriceId } from '@/lib/stripe';
import { applyStripeSubscriptionToCache } from '@/lib/stripe-billing-cache';
import { getOnboardingState } from '@/lib/onboarding';
import { onboardingGateRedirect } from '@/lib/admin-guard';
import { purgeTenant } from '@/lib/tenant-purge';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const steps: any[] = [];
  const assert = async (label: string, expectStep: string | null, expectRedirect: string | null, groupId: string) => {
    const st = await getOnboardingState(groupId);
    const rd = await onboardingGateRedirect(groupId);
    const pass = (st.firstIncompleteStep ?? null) === expectStep && rd === expectRedirect;
    steps.push({ label, expectStep, gotStep: st.firstIncompleteStep ?? null, expectRedirect, gotRedirect: rd, onboarded: st.onboarded, pass });
    return pass;
  };

  let groupId: string | null = null;
  try {
    const stamp = crypto.randomUUID().slice(0, 8);
    const email = `zz-onboard-${stamp}@example.com`;

    // 0. Register-equivalent: group (neutral name, no site) + owner. Mirrors register-garage.
    const group = await prisma.group.create({ data: { group_name: 'New garage', billing_email: email, status: 'trial' } });
    groupId = group.id;
    const owner = await prisma.user.create({ data: { name: 'ZZ Owner', email, passwordHash: 'x', role: 'ADMIN', is_owner: true, group_id: group.id, is_active: true, emailVerified: new Date() } });
    await assert('after register (group, no site)', 'site', '/onboarding/setup', group.id);

    // 1. Site step (mirrors /api/onboarding/setup): site + billing + link user.
    const site = await prisma.site.create({ data: { group_id: group.id, site_name: 'ZZ Workshop', timezone: 'Europe/London', currency_code: 'GBP', locale: 'en-GB', users: { connect: { id: owner.id } } } });
    await prisma.groupBilling.create({ data: { group_id: group.id, plan_name: 'TRIAL', status: 'ok', retention_months: 12, included_sites: 1, active_sites_cnt: 1 } });
    await prisma.user.update({ where: { id: owner.id }, data: { site_id: site.id } });
    await assert('after site step', 'rates', '/onboarding/rates-settings', group.id);

    // 2. Rates step (mirrors /api/onboarding/update-rates): LABOUR_HR service w/ labour rate = the signal.
    await prisma.serviceCatalogue.create({ data: { group_id: group.id, site_id: site.id, service_code: 'LABOUR_HR', name: 'Labour (per hour)', default_labour_rate: new Prisma.Decimal('75.00'), default_price: new Prisma.Decimal('75.00'), vat_rate: new Prisma.Decimal('20.00'), is_active: true } });
    await assert('after rates step', 'tax', '/onboarding/tax', group.id);

    // 3. Tax step (mirrors /api/onboarding/tax): tax_default_rate_bp non-NULL = the signal.
    await prisma.group.update({ where: { id: group.id }, data: { tax_country_code: 'GB', vat_registered: true, vat_number: 'GB123456789', tax_default_rate_bp: 2000, default_vat_rate: new Prisma.Decimal('20.00') } });
    await assert('after tax step', 'checkout', '/onboarding/billing', group.id);

    // 4. Checkout step: a REAL sandbox Stripe trial, then the SAME cache write confirm-checkout does.
    const stripe = getStripe();
    const priceId = stripePriceId();
    let stripeInfo: any = { configured: !!stripe && !!priceId };
    if (stripe && priceId) {
      const customer = await stripe.customers.create({ email, name: 'ZZ Onboard Proof' });
      const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
      const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: priceId, quantity: 1 }], trial_period_days: 60, default_payment_method: pm.id });
      stripeInfo = { configured: true, subscriptionId: sub.id, status: sub.status, trial_end: (sub as any).trial_end };
      // This is exactly what /api/stripe/confirm-checkout does after retrieving the session's subscription.
      await applyStripeSubscriptionToCache(sub as any, group.id);
    }
    const okFinal = await assert('after checkout (real sandbox trial → cache)', null, null, group.id);

    // Prove the trial clock now comes from Stripe, not the local signup timestamp.
    const g2 = await prisma.group.findUnique({ where: { id: group.id }, select: { trial_ends_at: true } });
    const trialFromStripe = stripeInfo.trial_end ? Math.abs(Math.floor((g2?.trial_ends_at?.getTime() ?? 0) / 1000) - stripeInfo.trial_end) < 5 : null;

    const before = await prisma.group.count({ where: { id: group.id } });

    // 5. Cleanup: purge the ZZ tenant (cancels the Stripe sub too).
    const op = await prisma.platformOperator.findFirst({ select: { user_id: true } });
    const purge = await purgeTenant(op?.user_id ?? owner.id, group.id);
    groupId = null;
    const after = await prisma.group.count({ where: { id: group.id } });

    return res.status(200).json({
      ok: steps.every((s) => s.pass) && okFinal,
      allStepsPass: steps.every((s) => s.pass),
      steps,
      stripe: stripeInfo,
      trialEndsAtMatchesStripe: trialFromStripe,
      purge: { groupExistedBefore: before, groupExistsAfter: after, stripeCanceled: purge.stripe.canceled, auditId: purge.auditId },
    });
  } catch (e: any) {
    // Best-effort cleanup on failure.
    if (groupId) { try { const op = await prisma.platformOperator.findFirst({ select: { user_id: true } }); await purgeTenant(op?.user_id ?? '00000000-0000-0000-0000-000000000000', groupId); } catch {} }
    console.error('[onboard-proof] failed', e?.message);
    return res.status(500).json({ ok: false, error: e?.message, steps });
  }
}
