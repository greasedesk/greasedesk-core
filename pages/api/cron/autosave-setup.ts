/**
 * File: pages/api/cron/autosave-setup.ts — TEMPORARY (Option B verification setup). DELETE after.
 * CRON_SECRET-guarded. op=setup → a throwaway ZZ tenant + owner (known pw) + a DRAFT card whose Quote
 * tab is reachable and EMPTY, so I can build a quote by hand in the browser and prove autosave/resume.
 * op=lines → read the card's lines (MY confirmation only — the PROOF is the browser + reload).
 * op=purge → purge the ZZ tenant. TMBS never touched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { purgeTenant } from '@/lib/tenant-purge';
import { appBaseUrl } from '@/lib/stripe';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });
  const op = String(req.query.op || '');

  if (op === 'lines') {
    const cardId = String(req.query.cardId || '');
    const lines = await prisma.jobCardItem.findMany({ where: { job_card_id: cardId }, orderBy: { created_at: 'asc' }, select: { item_type: true, description: true, unit_price: true, qty: true } });
    const cards = await prisma.jobCard.count({ where: { group_id: String(req.query.groupId || ''), status: 'draft' } });
    return res.status(200).json({ cardId, lineCount: lines.length, lines, draftCardCount: cards });
  }
  if (op === 'purge') {
    const g = String(req.query.groupId || '');
    const opr = await prisma.platformOperator.findFirst({ select: { user_id: true } });
    const r = await purgeTenant(opr?.user_id ?? '00000000-0000-0000-0000-000000000000', g);
    return res.status(200).json({ purged: true, groupGone: r.after.Group === 0 });
  }
  if (op === 'setup') {
    const stamp = crypto.randomUUID().slice(0, 8);
    const email = `zz-autosave-${stamp}@example.com`;
    const password = 'ReproPass123!';
    const group = await prisma.group.create({ data: { group_name: 'ZZ Autosave', billing_email: email, status: 'trial', tax_default_rate_bp: 2000 } });
    const site = await prisma.site.create({ data: { group_id: group.id, site_name: 'ZZ Workshop', timezone: 'Europe/London', currency_code: 'GBP', locale: 'en-GB' } });
    const owner = await prisma.user.create({ data: { name: 'ZZ Owner', email, passwordHash: await bcrypt.hash(password, 12), role: 'ADMIN', is_owner: true, group_id: group.id, site_id: site.id, is_active: true, emailVerified: new Date(), site_assignments: { create: { site_id: site.id } } } });
    await prisma.groupBilling.create({ data: { group_id: group.id, plan_name: 'TRIAL', status: 'ok', retention_months: 12, included_sites: 1, active_sites_cnt: 1, subscription_status: 'trialing' } });
    await prisma.serviceCatalogue.create({ data: { group_id: group.id, site_id: site.id, service_code: 'LABOUR_HR', name: 'Labour (per hour)', default_labour_rate: '75.00', default_price: '75.00', vat_rate: '20.00', is_active: true } });
    await prisma.resource.create({ data: { site_id: site.id, name: 'Lift 1', type: 'lift' } });
    const customer = await prisma.customer.create({ data: { group_id: group.id, site_id: site.id, name: 'Repro Customer' } });
    const vehicle = await prisma.vehicle.create({ data: { group_id: group.id, registration: 'ZZ22AUT', registration_normalized: 'ZZ22AUT', make: 'Test', model: 'Auto' } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: vehicle.id, customer_id: customer.id, is_current: true } });
    // DRAFT, details done → Quote tab reachable; NO estimate lines (build them by hand in the browser).
    const card = await prisma.jobCard.create({ data: { group_id: group.id, site_id: site.id, vehicle_id: vehicle.id, customer_id: customer.id, status: 'draft', vat_rate: new Prisma.Decimal('20.00'), stage_details_done: true } as any });
    const base = appBaseUrl();
    return res.status(200).json({ email, password, groupId: group.id, cardId: card.id, cardUrl: `${base}/admin/jobcards/${card.id}` });
  }
  return res.status(400).json({ message: 'unknown op' });
}
