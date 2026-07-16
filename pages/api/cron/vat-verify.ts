/**
 * File: pages/api/cron/vat-verify.ts — TEMPORARY (VAT report verification). DELETE after. CRON_SECRET.
 * op=setup → ZZ tenant + owner (creds) + issued invoices dated in THIS quarter:
 *   A (chargeable): £100 @ 20% → VAT £20
 *   B (chargeable): £50 @ 20% (£10) + £30 @ 0% (£0)
 *   C (WARRANTY)  : £200 — must be EXCLUDED from VAT on sales
 * Expected report (this quarter): net £180.00, output VAT £30.00, invoices 2; 20%→net150/vat30/2 lines, 0%→net30/vat0/1 line.
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

  if (op === 'purge') {
    const g = String(req.query.groupId || '');
    const opr = await prisma.platformOperator.findFirst({ select: { user_id: true } });
    const r = await purgeTenant(opr?.user_id ?? '00000000-0000-0000-0000-000000000000', g);
    return res.status(200).json({ purged: true, groupGone: r.after.Group === 0 });
  }

  if (op === 'setup') {
    const stamp = crypto.randomUUID().slice(0, 8);
    const email = `zz-vat-${stamp}@example.com`;
    const password = 'ReproPass123!';
    const issued = new Date(Date.parse('2026-07-10T10:00:00.000Z')); // in Q3 2026 (this quarter as of 2026-07-16)
    const group = await prisma.group.create({ data: { group_name: 'ZZ VAT Co', billing_email: email, status: 'trial', tax_default_rate_bp: 2000, vat_registered: true, vat_number: 'GB999888777' } });
    const site = await prisma.site.create({ data: { group_id: group.id, site_name: 'ZZ Workshop', timezone: 'Europe/London', currency_code: 'GBP', locale: 'en-GB' } });
    await prisma.user.create({ data: { name: 'ZZ Owner', email, passwordHash: await bcrypt.hash(password, 12), role: 'ADMIN', is_owner: true, group_id: group.id, site_id: site.id, is_active: true, emailVerified: new Date(), site_assignments: { create: { site_id: site.id } } } });
    await prisma.groupBilling.create({ data: { group_id: group.id, plan_name: 'TRIAL', status: 'ok', retention_months: 12, included_sites: 1, active_sites_cnt: 1, subscription_status: 'trialing' } });

    async function invoice(seq: number, series: 'chargeable' | 'warranty', lines: Array<{ net: number; rate: number }>) {
      const veh = await prisma.vehicle.create({ data: { group_id: group.id, registration: `ZZ${seq}${series[0].toUpperCase()}`, registration_normalized: `ZZ${seq}${series[0].toUpperCase()}` } });
      const card = await prisma.jobCard.create({ data: { group_id: group.id, site_id: site.id, vehicle_id: veh.id, status: series === 'warranty' ? 'paid' : 'invoiced', vat_rate: new Prisma.Decimal('20.00') } as any });
      const inv = await prisma.invoice.create({ data: {
        group_id: group.id, site_id: site.id, job_card_id: card.id, status: series === 'warranty' ? 'settled' : 'issued', series,
        sequence_value: seq, invoice_number: `${series === 'warranty' ? 'W' : ''}${seq}`, issued_at: issued, date_issued: issued,
        company_name_snapshot: 'ZZ VAT Co', customer_name_snapshot: 'Cust', vat_registered_at_issue: true,
      } as any });
      for (const [i, l] of lines.entries()) {
        const vat = Math.round(l.net * (l.rate / 100) * 100) / 100;
        await prisma.invoiceLine.create({ data: { invoice_id: inv.id, description: `line ${i}`, qty: new Prisma.Decimal(1), unit_price: new Prisma.Decimal(l.net.toFixed(2)), vat_rate: new Prisma.Decimal(l.rate.toFixed(2)), line_vat: new Prisma.Decimal(vat.toFixed(2)), line_total: new Prisma.Decimal(l.net.toFixed(2)), position: i } });
      }
    }
    await invoice(1, 'chargeable', [{ net: 100, rate: 20 }]);
    await invoice(2, 'chargeable', [{ net: 50, rate: 20 }, { net: 30, rate: 0 }]);
    await invoice(1, 'warranty', [{ net: 200, rate: 0 }]); // must be excluded

    const base = appBaseUrl();
    return res.status(200).json({ email, password, groupId: group.id, reportUrl: `${base}/admin/reports/vat`, expected: { net: '£180.00', vat: '£30.00', invoices: 2 } });
  }
  return res.status(400).json({ message: 'unknown op' });
}
