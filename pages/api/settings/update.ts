/**
 * File: pages/api/settings/update.ts
 * Last edited: 2025-11-13 12:38 Europe/London (FINAL FIX - ADDED TX TYPE)
 *
 * Purpose:
 * Saves Admin → System Settings for the active Site/Group.
 * Validates ownership, persists VAT rate, labour rate, and regional settings.
 *
 * Improvements:
 * - Uses findFirst + update/create (safe against non-unique upserts)
 * - Validates that the current user truly owns the site/group
 * - Uses Prisma.Decimal for currency fields
 * - Clean error handling and logging
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';

type SaveSettingsBody = {
  defaultVatRate: number | string;
  defaultLabourRate: number | string;
  timezone?: string;
  currencyCode?: string;
  pricingDisplayMode: 'ex_vat' | 'inc_vat';
  supportedCountries: string[];
  supportedCurrencies: string[];
};

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ message: 'Method Not Allowed' });

  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({
      message:
        'Authentication Error: Group/Site context not found. Please sign in again.',
    });
  }

  const groupId = user.group_id;
  const siteId = user.site_id;

  const {
    defaultVatRate,
    defaultLabourRate,
    timezone,
    currencyCode,
    pricingDisplayMode,
    supportedCountries,
    supportedCurrencies,
  } = req.body as SaveSettingsBody;

  const vat = Number(defaultVatRate);
  const labour = Number(defaultLabourRate);

  if (!Number.isFinite(vat) || vat < 0 || vat > 100) {
    return res.status(400).json({ message: 'Invalid VAT rate' });
  }
  if (!Number.isFinite(labour) || labour < 0) {
    return res.status(400).json({ message: 'Invalid labour rate' });
  }

  try {
    // Ensure this site truly belongs to this group
    const site = await prisma.site.findUnique({
      where: { id: siteId },
      select: { group_id: true },
    });

    if (!site || site.group_id !== groupId) {
      return res.status(403).json({
        message:
          'Authorisation Error: You do not have permission to modify this site.',
      });
    }

    // 🌟 FIX: Explicitly type the transaction client 'tx' as Prisma.TransactionClient
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1️⃣ Update Site configuration
      await tx.site.update({
        where: { id: siteId },
        data: {
          ...(timezone && { timezone }),
          ...(currencyCode && { currency_code: currencyCode }),
          pricing_display_mode: pricingDisplayMode,
          supported_countries: supportedCountries ?? [],
          supported_currencies: supportedCurrencies ?? [],
        },
      });

      // 2️⃣ Maintain Group VAT rate
      const existingVat = await tx.taxRate.findFirst({
        where: { group_id: groupId, name: 'UK VAT' },
        select: { id: true },
      });

      if (existingVat) {
        await tx.taxRate.update({
          where: { id: existingVat.id },
          data: {
            percentage: new Prisma.Decimal(vat.toFixed(2)),
          },
        });
      } else {
        await tx.taxRate.create({
          data: {
            group_id: groupId,
            name: 'UK VAT',
            percentage: new Prisma.Decimal(vat.toFixed(2)),
            valid_from: new Date(),
          },
        });
      }

      // 3️⃣ Maintain default labour service for this site
      const existingLabour = await tx.serviceCatalogue.findFirst({
        where: { group_id: groupId, site_id: siteId, service_code: 'LABOUR_HR' },
        select: { id: true },
      });

      const rateDec = new Prisma.Decimal(labour.toFixed(2));
      const vatDec = new Prisma.Decimal(vat.toFixed(2));

      if (existingLabour) {
        await tx.serviceCatalogue.update({
          where: { id: existingLabour.id },
          data: {
            name: 'Labour (per hour)',
            description: 'Standard labour rate per hour (ex VAT).',
            default_duration_minutes: 60,
            default_labour_rate: rateDec,
            default_price: rateDec,
            vat_rate: vatDec,
            is_active: true,
          },
        });
      } else {
        await tx.serviceCatalogue.create({
          data: {
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
      }
    });

    return res.status(200).json({ message: 'Settings saved successfully!' });
  } catch (error: any) {
    console.error('Settings Update Error:', error);
    return res.status(500).json({
      message: 'Failed to save settings. Check logs for details.',
    });
  }
}