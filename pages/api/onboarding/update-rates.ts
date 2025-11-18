/**
 * File: pages/api/onboarding/update-rates.ts
 * Last edited: 2025-11-18 16:45 Europe/London
 *
 * Description: API to save initial site configuration (VAT, Labour, Regional) during onboarding.
 * NOTE:
 *  - We now re-fetch the user from the database using session.user.id to get
 *    the latest group_id / site_id, so we’re not relying on stale JWT fields.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { Prisma } from '@prisma/client';

type SaveRatesBody = {
  defaultVatRate: string;
  defaultLabourRate: string;
  timezone: string;
  currencyCode: string;
};

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const session = await getServerSession(req, res, authOptions);
  const sessionUser = session?.user as any;

  if (!sessionUser?.id) {
    return res.status(401).json({
      message: 'Authentication Error: User session not found. Please sign in again.',
    });
  }

  // Always load fresh user context from DB so we see the latest group/site
  const dbUser = await prisma.user.findUnique({
    where: { id: sessionUser.id as string },
    select: { group_id: true, site_id: true },
  });

  if (!dbUser?.group_id || !dbUser?.site_id) {
    return res.status(401).json({
      message:
        'Authentication Error: Group/Site context not found. Please complete previous setup steps.',
    });
  }

  const groupId = dbUser.group_id;
  const siteId = dbUser.site_id;

  const {
    defaultVatRate,
    defaultLabourRate,
    timezone,
    currencyCode,
  } = req.body as SaveRatesBody;

  const vat = Number(defaultVatRate);
  const labour = Number(defaultLabourRate);

  if (!Number.isFinite(vat) || vat < 0 || vat > 100) {
    return res.status(400).json({ message: 'Invalid VAT rate' });
  }
  if (!Number.isFinite(labour) || labour < 0) {
    return res.status(400).json({ message: 'Invalid labour rate' });
  }

  try {
    // 2. Perform Atomic Database Update
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // A. Update Site Regional configuration
      await tx.site.update({
        where: { id: siteId },
        data: {
          timezone: timezone,
          currency_code: currencyCode,
        },
      });

      // B. Update/Upsert Group VAT rate (using deterministic id)
      const vatDec = new Prisma.Decimal(vat.toFixed(2));
      const ukVatId = `${groupId}-UK-VAT`;

      await tx.taxRate.upsert({
        where: { id: ukVatId },
        update: {
          percentage: vatDec,
        },
        create: {
          id: ukVatId,
          group_id: groupId,
          name: 'UK VAT',
          percentage: vatDec,
          valid_from: new Date(),
        },
      });

      // C. Update/Upsert default labour service for this site (also deterministic id)
      const rateDec = new Prisma.Decimal(labour.toFixed(2));
      const labourServiceId = `${groupId}-${siteId}-LABOUR_HR`;

      await tx.serviceCatalogue.upsert({
        where: { id: labourServiceId },
        update: {
          default_labour_rate: rateDec,
          default_price: rateDec,
          vat_rate: vatDec,
        },
        create: {
          id: labourServiceId,
          group_id: groupId,
          site_id: siteId,
          service_code: 'LABOUR_HR',
          name: 'Labour (per hour)',
          description: 'Standard labour rate per hour (ex VAT).',
          default_duration_minutes: 60,
          default_labour_rate: rateDec,
          default_price: rateDec,
          vat_rate: vatDec,
          is_active: true,
        },
      });
    });

    return res.status(200).json({ message: 'Rates saved successfully!' });
  } catch (error) {
    console.error('Update Rates Error:', error);
    return res.status(500).json({
      message: 'Failed to save financial settings. Check logs for details.',
    });
  }
}
