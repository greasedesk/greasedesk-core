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
import { requireAdminApi } from '@/lib/admin-guard';

type SaveSettingsBody = {
  siteId?: string; // target location (all-locations Financial); defaults to caller's site
  defaultLabourRate: number | string;
  timezone?: string;
  currencyCode?: string;
  pricingDisplayMode: 'ex_vat' | 'inc_vat';
  supportedCountries: string[];
};

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ message: 'Method Not Allowed' });

  // ADMIN-ONLY: financial settings must not be writable by STANDARD users.
  if (!(await requireAdminApi(req, res))) return;

  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({
      message:
        'Authentication Error: Group/Site context not found. Please sign in again.',
    });
  }

  const groupId = user.group_id;

  const {
    siteId: bodySiteId,
    defaultLabourRate,
    timezone,
    currencyCode,
    pricingDisplayMode,
    supportedCountries,
  } = req.body as SaveSettingsBody;

  // All-locations Financial: target any site the caller's group owns (validated below). Defaults
  // to the caller's own site when no target is supplied.
  const siteId = (typeof bodySiteId === 'string' && bodySiteId) || user.site_id;

  const labour = Number(defaultLabourRate);
  if (!Number.isFinite(labour) || labour < 0) {
    return res.status(400).json({ message: 'Invalid labour rate' });
  }

  // VAT rate is no longer set here — it's the ONE company default on Group (Company Details). The
  // labour service carries a vat_rate for legacy shape only (unread), mirrored from that default.
  const grp = (await prisma.group.findUnique({ where: { id: groupId }, select: { default_vat_rate: true } })) as { default_vat_rate: unknown } | null;
  const companyVat = grp && grp.default_vat_rate != null ? Number(grp.default_vat_rate) : 20;

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
          // supported_currencies intentionally NOT written — the multi-select was removed (nothing
          // consumed it; it implied multi-currency invoicing that doesn't exist). Column left in place.
        },
      });

      // 2️⃣ Maintain default labour service for this site (VAT rate mirrors the company default).
      const existingLabour = await tx.serviceCatalogue.findFirst({
        where: { group_id: groupId, site_id: siteId, service_code: 'LABOUR_HR' },
        select: { id: true },
      });

      const rateDec = new Prisma.Decimal(labour.toFixed(2));
      const vatDec = new Prisma.Decimal(companyVat.toFixed(2));

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