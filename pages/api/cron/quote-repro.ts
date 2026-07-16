/**
 * File: pages/api/cron/quote-repro.ts — TEMPORARY (bug repro). DELETE after. CRON_SECRET-guarded.
 * op=diag    → { dvlaConfigured, dvsaConfigured } (Bug 1: which reg-lookup provider is live in prod).
 * op=setup   → throwaway ZZ tenant + owner (known pw) + site + resource + a DRAFT job card w/ one
 *              estimate line. Returns creds + card URL so I can drive the real Quote "Save" in a browser.
 * op=lines   → the card's current JobCardItem lines (verify persistence after clicking Save + reload).
 * op=purge   → purge the ZZ tenant. TMBS never touched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { dvlaConfigured } from '@/lib/dvla';
import { dvsaConfigured } from '@/lib/dvsa';
import { purgeTenant } from '@/lib/tenant-purge';
import { appBaseUrl } from '@/lib/stripe';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });
  const op = String(req.query.op || '');

  if (op === 'diag') {
    return res.status(200).json({ dvlaConfigured: dvlaConfigured(), dvsaConfigured: dvsaConfigured() });
  }

  if (op === 'lines') {
    const cardId = String(req.query.cardId || '');
    const lines = await prisma.jobCardItem.findMany({ where: { job_card_id: cardId }, orderBy: { created_at: 'asc' }, select: { id: true, item_type: true, description: true, qty: true, unit_price: true } });
    return res.status(200).json({ cardId, count: lines.length, lines });
  }

  if (op === 'purge') {
    const groupId = String(req.query.groupId || '');
    const op0 = await prisma.platformOperator.findFirst({ select: { user_id: true } });
    const r = await purgeTenant(op0?.user_id ?? '00000000-0000-0000-0000-000000000000', groupId);
    return res.status(200).json({ purged: true, groupStillExists: r.after.Group > 0 });
  }

  if (op === 'setup') {
    const stamp = crypto.randomUUID().slice(0, 8);
    const email = `zz-quote-${stamp}@example.com`;
    const password = 'ReproPass123!';
    const group = await prisma.group.create({ data: { group_name: 'ZZ Quote Repro', billing_email: email, status: 'trial', tax_default_rate_bp: 2000 } });
    const passwordHash = await bcrypt.hash(password, 12);
    const site = await prisma.site.create({ data: { group_id: group.id, site_name: 'ZZ Workshop', timezone: 'Europe/London', currency_code: 'GBP', locale: 'en-GB' } });
    const owner = await prisma.user.create({ data: { name: 'ZZ Owner', email, passwordHash, role: 'ADMIN', is_owner: true, group_id: group.id, site_id: site.id, is_active: true, emailVerified: new Date(), site_assignments: { create: { site_id: site.id } } } });
    // Billing so the onboarding gate passes (site+rates+tax+sub). Give it a live trial status.
    await prisma.groupBilling.create({ data: { group_id: group.id, plan_name: 'TRIAL', status: 'ok', retention_months: 12, included_sites: 1, active_sites_cnt: 1, subscription_status: 'trialing' } });
    await prisma.serviceCatalogue.create({ data: { group_id: group.id, site_id: site.id, service_code: 'LABOUR_HR', name: 'Labour (per hour)', default_labour_rate: '75.00', default_price: '75.00', vat_rate: '20.00', is_active: true } });
    const resource = await prisma.resource.create({ data: { site_id: site.id, name: 'Lift 1', type: 'lift' } });
    const customer = await prisma.customer.create({ data: { group_id: group.id, site_id: site.id, name: 'Repro Customer' } });
    const vehicle = await prisma.vehicle.create({ data: { group_id: group.id, registration: 'ZZ11REP', registration_normalized: 'ZZ11REP', make: 'Test', model: 'Repro' } });
    const card = await prisma.jobCard.create({ data: { group_id: group.id, site_id: site.id, vehicle_id: vehicle.id, customer_id: customer.id, status: 'draft', vat_rate: '20.00', resource_id: resource.id } });
    await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: 'Original labour line', qty: '1.00', unit_price: '100.00', vat_rate: '20.00' } });
    const base = appBaseUrl();
    return res.status(200).json({ email, password, groupId: group.id, cardId: card.id, cardUrl: `${base}/admin/jobcards/${card.id}` });
  }

  return res.status(400).json({ message: 'unknown op' });
}
