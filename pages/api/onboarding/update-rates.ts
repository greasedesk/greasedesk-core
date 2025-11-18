/**
 * File: pages/api/onboarding/update-rates.ts
 * Last edited: 2025-11-18 18:27 Europe/London
 *
 * Description:
 * Saves initial VAT, labour rate, and regional config during onboarding.
 * Uses fresh DB lookup for tenant context → no stale JWT/session values.
 * Fully multi-tenant safe (Group + Site are enforced at DB level).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { Prisma } from '@prisma/client';

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // ──────────────────────────────────────────────
  // AUTH + TENANT CONTEXT RESOLUTION
  // ──────────────────────────────────────────────
  const session = await getServerSession(req, res, authOptions);
  const sessionUser = session?.user as any;

  if (!sessionUser?.id) {
    return res.status(401).json({
      message: 'Authentication Error: User session not found. Please sign in again.',
    });
  }

  // Load FRESH user context from DB (NEVER trust token values)
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

  // ──────────────────────────────────────────────
  // INPUT VALIDATION
  // ──────────────────────────────────────────────
  const { defaultVatRate, defaultLabourRate, timezone, currencyCode } = req.body;

  const vat = Number(defaultVatRate);
  const labour = Number(defaultLabourRate);

  if (!Number.isFinite(vat) || vat < 0 || vat > 100) {
    return res.status(400).json({ message: 'Invalid VAT rate' });
  }
  if (!Number.isFinite(labour) || labour < 0) {
    return res.status(400).json({ message: 'Invalid labour rate' });
  }

  // ──────────────────────────────────────────────
  // DB UPDATE
  // ──────────────────────────────────────────────
  try {
    const vatDec = new Prisma.Decimal(vat.toFixed(2));
    const rateDec = new Prisma.Decimal(labour.toFixed(2));

    await prisma.$transaction(async (tx) => {
      // A. Site regional configuration
      await tx.site.update({
        where: { id: siteId },
        data: { timezone, currency_code: currencyCode },
      });

      // B. VAT rate
      await tx.taxRate.upsert({
        where: { id: `${groupId}-UK-VAT` },
        update: { percentage: vatDec },
        create: {
          id: `${groupId}-UK-VAT`,
          group_id: groupId,
          name: 'UK VAT',
          percentage: vatDec,
          valid_from: new Date(),
        },
      });

      // C. Default labour service
      await tx.serviceCatalogue.upsert({
        where: { id: `${groupId}-${siteId}-LABOUR_HR` },
        update: {
          default_labour_rate: rateDec,
          default_price: rateDec,
          vat_rate: vatDec,
        },
        create: {
          id: `${groupId}-${siteId}-LABOUR_HR`,
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
