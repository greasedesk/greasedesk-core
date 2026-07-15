// pages/api/onboarding/update-rates.ts
// Updated 15/12/2025
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireAdminApi } from '@/lib/admin-guard';

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

  // ADMIN-ONLY: rate/config writes are not permitted for STANDARD users.
  if (!(await requireAdminApi(req, res))) return;

  const session = await getServerSession(req, res, authOptions);
  const sessionUser = session?.user as any;

  if (!sessionUser?.email && !sessionUser?.id) {
    return res.status(401).json({
      message: 'Authentication Error: User session not found. Please sign in again.',
    });
  }

  const userIdFromSession = sessionUser.id as string | undefined;
  const userEmailFromSession = sessionUser.email as string | undefined;

  // ─────────────────────────────────────────────────────────────
  // 1. Load user FRESH from the DB (by id, then by email)
  // ─────────────────────────────────────────────────────────────
  let dbUser =
    userIdFromSession
      ? await prisma.user.findUnique({
          where: { id: userIdFromSession },
          select: { id: true, email: true, group_id: true, site_id: true },
        })
      : null;

  if (!dbUser && userEmailFromSession) {
    dbUser = await prisma.user.findUnique({
      where: { email: userEmailFromSession },
      select: { id: true, email: true, group_id: true, site_id: true },
    });
  }

  if (!dbUser) {
    return res.status(401).json({
      message: 'Authentication Error: User not found in database.',
    });
  }

  let { id: userId, email: userEmail, group_id: groupId, site_id: siteId } = dbUser;

  // ─────────────────────────────────────────────────────────────
  // 2. SELF-HEAL MISSING group_id / site_id IF POSSIBLE
  //    (for older seed data / legacy registrations)
  // ─────────────────────────────────────────────────────────────
  const userUpdateData: Prisma.UserUpdateInput = {};

  // Try to recover group_id by matching Group.billing_email to user email
  if (!groupId && userEmail) {
    const existingGroup = await prisma.group.findFirst({
      where: { billing_email: userEmail },
      select: { id: true },
    });

    if (existingGroup) {
      groupId = existingGroup.id;
      // ✅ Removed: userUpdateData.group_id = existingGroup.id;  // → Not allowed in UserUpdateInput
    }
  }

  // Try to recover site_id by finding the first Site for this group
  if (!siteId && groupId) {
    const existingSite = await prisma.site.findFirst({
      where: { group_id: groupId },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });

    if (existingSite) {
      siteId = existingSite.id;
      // ✅ Removed: userUpdateData.site_id = existingSite.id;  // → Not allowed in UserUpdateInput
    }
  }

  // NOTE: We no longer attempt to update group_id/site_id via User.update()
  // because they are not writable fields in UserUpdateInput.
  // Instead, we only store the recovered IDs in groupId/siteId variables for later use.
  // The current logic is correct: we are just restoring context — not changing user relations.
  // After self-heal, if we STILL don’t have group/site, we must stop.
  if (!groupId || !siteId) {
    return res.status(401).json({
      message:
        'Authentication Error: Group/Site context not found. Please complete previous setup steps.',
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Validate incoming body
  // ─────────────────────────────────────────────────────────────
  const { defaultVatRate, defaultLabourRate, timezone, currencyCode } =
    req.body as SaveRatesBody;

  const labour = Number(defaultLabourRate);
  if (!Number.isFinite(labour) || labour < 0) {
    return res.status(400).json({ message: 'Invalid labour rate' });
  }

  // VAT/tax is now its OWN onboarding step (item-13) — the rates step no longer sends it. Accept it
  // when present (legacy/settings callers), skip the VAT writes when absent.
  const hasVat = defaultVatRate != null && String(defaultVatRate).trim() !== '';
  const vat = hasVat ? Number(defaultVatRate) : NaN;
  if (hasVat && (!Number.isFinite(vat) || vat < 0 || vat > 100)) {
    return res.status(400).json({ message: 'Invalid VAT rate' });
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Atomic DB update for Site, TaxRate, ServiceCatalogue
  // ─────────────────────────────────────────────────────────────
  try {
    // The service's VAT rate falls back to the group's current default when this call carries no VAT
    // (the onboarding rates step). The tax step is authoritative for VAT.
    const grpForVat = hasVat ? null : (await prisma.group.findUnique({ where: { id: groupId! }, select: { default_vat_rate: true } }));
    const serviceVatDec = hasVat ? new Prisma.Decimal(vat.toFixed(2)) : new Prisma.Decimal(grpForVat?.default_vat_rate ?? 20);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // A. Site regional settings. The labour rate lives on the LABOUR_HR ServiceCatalogue row
      // (written in step C) — that row is the onboarding "rates done" SIGNAL the root gate reads
      // (item-13), so writing it advances the wizard past the rates step.
      const rateDec = new Prisma.Decimal(labour.toFixed(2));
      await tx.site.update({
        where: { id: siteId! },
        data: {
          timezone,
          currency_code: currencyCode,
        },
      });

      // B. VAT writes only when this caller carried a VAT value (legacy / settings path).
      if (hasVat) {
        const vatDec = new Prisma.Decimal(vat.toFixed(2));
        // Company default VAT rate on Group — THE source that cascades as the pre-fill everywhere.
        await tx.group.update({ where: { id: groupId! }, data: { default_vat_rate: vatDec } });
        // Legacy 'UK VAT' TaxRate (deterministic id per group) — kept for the legacy rates page.
        const ukVatId = `${groupId}-UK-VAT`;
        await tx.taxRate.upsert({
          where: { id: ukVatId },
          update: { percentage: vatDec },
          create: { id: ukVatId, group_id: groupId!, name: 'UK VAT', percentage: vatDec, valid_from: new Date() },
        });
      }

      // C. Default labour service for this site
      const labourServiceId = `${groupId}-${siteId}-LABOUR_HR`;
      await tx.serviceCatalogue.upsert({
        where: { id: labourServiceId },
        update: {
          default_labour_rate: rateDec,
          default_price: rateDec,
          vat_rate: serviceVatDec,
        },
        create: {
          id: labourServiceId,
          group_id: groupId!,
          site_id: siteId!,
          service_code: 'LABOUR_HR',
          name: 'Labour (per hour)',
          description: 'Standard labour rate per hour (ex VAT).',
          default_duration_minutes: 60,
          default_labour_rate: rateDec,
          default_price: rateDec,
          vat_rate: serviceVatDec,
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