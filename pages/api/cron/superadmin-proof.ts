/**
 * File: pages/api/cron/superadmin-proof.ts
 * TEMPORARY proof harness for the SuperAdmin purge (delete after the run). Runs ON Vercel where R2
 * + Stripe keys live. CRON_SECRET. Creates a FULL throwaway ZZ tenant (DB + real R2 object + real
 * Stripe sub), runs the real purgeTenant, and reports before/after counts + R2 + Stripe + audit.
 * Never touches TMBS or any real tenant.
 *   ?op=full  → create → purge → verify, all in one, returning the whole proof.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getStripe, stripePriceId } from '@/lib/stripe';
import { presignPut, countByPrefix } from '@/lib/r2';
import { purgeTenant, countTenantRows } from '@/lib/tenant-purge';

export const config = { maxDuration: 60 };
const OPERATOR = '3255a238-a9f3-45a0-9ff9-2a69111c41fa'; // Iain (seeded operator)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ message: 'Not authorised.' });
  if (String(req.query.op) !== 'full') return res.status(400).json({ message: 'op=full' });

  const stamp = String(Date.now());
  try {
    // ── CREATE a full ZZ tenant (DB) ──
    const g = await prisma.group.create({ data: { group_name: 'ZZ Purge Proof', billing_email: `zz-purge-${stamp}@example.com` } });
    const site = await prisma.site.create({ data: { group_id: g.id, site_name: 'ZZ Site' } });
    const user = await prisma.user.create({ data: { name: 'ZZ User', email: `zz-user-${stamp}@example.com`, passwordHash: 'x', role: 'ADMIN', group_id: g.id, site_id: site.id, is_active: true } });
    const cust = await prisma.customer.create({ data: { group_id: g.id, site_id: site.id, name: 'ZZ Customer' } });
    const veh = await prisma.vehicle.create({ data: { group_id: g.id, registration: 'ZZ99ZZZ', registration_normalized: 'ZZ99ZZZ' } });
    const jc = await prisma.jobCard.create({ data: { group_id: g.id, site_id: site.id, vehicle_id: veh.id, customer_id: cust.id } });
    const photoId = `zz-${stamp}`;
    await prisma.jobCardPhoto.create({ data: { id: photoId, job_card_id: jc.id, group_id: g.id, stage: 'intake', slot: 'freeform', r2_key: `${g.id}/${jc.id}/intake/freeform/${photoId}.jpg`, uploaded_by: user.id } });
    await prisma.invoiceSequence.create({ data: { group_id: g.id } });
    const inv = await prisma.invoice.create({ data: { group_id: g.id, site_id: site.id, job_card_id: jc.id, series: 'chargeable', sequence_value: 1, invoice_number: `ZZ-${stamp.slice(-4)}`, company_name_snapshot: 'ZZ', customer_name_snapshot: 'ZZ Customer', vehicle_reg_snapshot: 'ZZ99ZZZ', vat_registered_at_issue: false } });
    await prisma.invoiceLine.create({ data: { invoice_id: inv.id, description: 'ZZ line', qty: 1, unit_price: 10, line_total: 10 } });
    await prisma.booking.create({ data: { group: { connect: { id: g.id } }, site: { connect: { id: site.id } }, vehicle: { connect: { id: veh.id } }, booking_date: new Date() } });
    await prisma.auditLog.create({ data: { group_id: g.id, user_id: user.id, entity: 'job_card', entity_id: jc.id, action: 'status.draft' } });
    await prisma.uploadTelemetry.create({ data: { group_id: g.id, job_card_id: jc.id, photo_id: photoId, kind: 'video', step: 'zz', status: 0 } });
    await prisma.vinReadShadow.create({ data: { group_id: g.id, photo_id: photoId, job_card_id: jc.id, engine: 'skipped' } });

    // ── real R2 object under the tenant prefix ──
    const r2key = `${g.id}/${jc.id}/intake/freeform/${photoId}.jpg`;
    let r2Uploaded = false;
    const url = await presignPut(r2key, 'image/jpeg');
    if (url) { const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }); r2Uploaded = put.ok; }
    const r2Before = await countByPrefix(`${g.id}/`);

    // ── real Stripe sub on GroupBilling ──
    const stripe = getStripe(); const price = stripePriceId();
    let subId: string | null = null; let custId: string | null = null;
    if (stripe && price) {
      const customer = await stripe.customers.create({ email: `zz-purge-${stamp}@example.com`, name: 'ZZ Purge' });
      custId = customer.id;
      const attached = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: attached.id } });
      const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price, quantity: 1 }], trial_period_days: 30, default_payment_method: attached.id });
      subId = sub.id;
    }
    await prisma.groupBilling.create({ data: { group_id: g.id, plan_name: 'TRIAL', status: 'ok', retention_months: 12, included_sites: 1, stripe_customer_id: custId ?? undefined, stripe_subscription_id: subId ?? undefined } });

    const before = await countTenantRows(g.id);

    // ── PURGE (the real thing) ──
    const result = await purgeTenant(OPERATOR, g.id);

    // ── VERIFY ──
    const afterR2 = await countByPrefix(`${g.id}/`);
    const audit = await prisma.superAdminAudit.findFirst({ where: { id: result.auditId }, select: { id: true, action: true, target_group_id: true, target_name_snapshot: true, target_ref_snapshot: true, operator_user_id: true } });
    let subStatus: string | null = null;
    if (stripe && subId) { try { const s = await stripe.subscriptions.retrieve(subId); subStatus = s.status; } catch { subStatus = 'gone'; } }
    const groupStillExists = (await prisma.group.count({ where: { id: g.id } })) > 0;
    const nonZeroAfter = Object.entries(result.after).filter(([, v]) => v > 0);

    return res.status(200).json({
      groupId: g.id, ref: result.refSnapshot,
      created: { r2Uploaded, r2ObjectsBefore: r2Before, stripeSubId: subId, nonZeroTablesBefore: Object.entries(before).filter(([, v]) => v > 0).length },
      purge: { stripe: result.stripe, r2Deleted: result.r2.deleted },
      verify: {
        allDbRowsZero: nonZeroAfter.length === 0, nonZeroAfter,
        r2ObjectsAfter: afterR2, groupStillExists,
        stripeSubStatusAfter: subStatus,
        superAdminAudit: audit,
      },
      before: result.before, after: result.after,
    });
  } catch (e: any) {
    return res.status(200).json({ error: { message: e?.message, code: e?.code, stack: (e?.stack || '').split('\n').slice(0, 4) } });
  }
}
