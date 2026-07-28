/**
 * File: pages/api/onboarding/setup.ts
 * Last edited: 2025-11-18 18:25 Europe/London
 *
 * Description:
 * Step 1 of onboarding. Ensures the logged-in user has:
 *  - A Group (created or updated)
 *  - A GroupBilling record
 *  - A primary Site (created or updated)
 *  - User.group_id and User.site_id set correctly
 *
 * This is multi-tenant safe and idempotent: calling it twice will not create
 * duplicate groups or sites, it will reuse and update existing records.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { trialEndsFromNow } from '@/lib/trial';
import { requireAdminApi } from '@/lib/admin-guard';
import { getProfile } from '@/lib/locale-profiles';
import { isUsStateCode, timezoneForState } from '@/lib/us-states';

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // ADMIN-ONLY: tenant (group/site) config writes are not permitted for STANDARD users.
  if (!(await requireAdminApi(req, res))) return;

  try {
    const session = await getServerSession(req, res, authOptions);

    if (!session?.user?.id || !session.user.email) {
      return res.status(401).json({ message: 'Authentication Error: Session not found.' });
    }

    // Load the latest user record from DB (never trust token state alone)
    const dbUser = await prisma.user.findUnique({
      where: { id: session.user.id as string },
      select: {
        id: true,
        email: true,
        group_id: true,
        site_id: true,
      },
    });

    if (!dbUser) {
      return res.status(401).json({ message: 'Authentication Error: User not found.' });
    }

    const { groupName, siteName, addressLine1, city, postcode, stateCode } = req.body as {
      groupName?: string;
      siteName?: string;
      addressLine1?: string;
      city?: string;
      postcode?: string;
      stateCode?: string;
    };

    // MANDATORY garage name (item-13) — no silent derivation from the person's name. The wizard
    // marks this required client-side; enforce it here so the tenant name is always the real garage.
    if (!groupName || !groupName.trim()) {
      return res.status(400).json({ message: 'Please enter your garage / company name.' });
    }
    if (!siteName || !siteName.trim()) {
      return res.status(400).json({ message: 'Please enter your primary location name.' });
    }

    // STATE (ruling 2026-07-28): required and validated for countries whose profile sets stateField
    // (US); rejected outright elsewhere — a UK tenant can never carry a US state. The timezone the
    // site is created with derives from the state (majority zone for split states), narrowing
    // WITHIN the profile's zone set by construction (lib/us-states only maps to profile zones).
    const grpCountry = dbUser.group_id
      ? await prisma.group.findUnique({ where: { id: dbUser.group_id }, select: { country_code: true, ref: true } })
      : null;
    const bodyProfile = getProfile(grpCountry?.country_code);
    const sentState = String(stateCode ?? '').trim().toUpperCase() || null;
    if (bodyProfile.stateField === true) {
      if (!sentState || !isUsStateCode(sentState)) {
        return res.status(400).json({ message: 'Please select your state from the list.' });
      }
    } else if (sentState) {
      return res.status(400).json({ message: 'State does not apply to your country.' });
    }
    const stateTimezone = bodyProfile.stateField === true ? timezoneForState(sentState) : null;

    const fullAddressParts = [addressLine1, city, postcode].filter(Boolean);
    const fullAddress = fullAddressParts.length ? fullAddressParts.join(', ') : null;

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let groupId = dbUser.group_id;
      let siteId = dbUser.site_id ?? undefined;

      // A. Ensure Group exists (create if user has no group yet)
      let group;

      if (groupId) {
        group = await tx.group.update({
          where: { id: groupId },
          data: {
            group_name: groupName.trim(),
          },
        });
      } else {
        // Upsert by billing_email so re-runs cannot create duplicates
        group = await tx.group.upsert({
          where: { billing_email: dbUser.email },
          update: {
            group_name: groupName ?? undefined,
          },
          create: {
            group_name:
              groupName ||
              (dbUser.email ? `${dbUser.email}'s Garage` : 'New Garage'),
            billing_email: dbUser.email,
            // ref auto-assigned by the DB sequence default; status defaults to 'trial'.
            trial_ends_at: trialEndsFromNow(),
          },
        });

        groupId = group.id;

        // Link user to the new group
        await tx.user.update({
          where: { id: dbUser.id },
          data: { group_id: groupId },
        });
      }

      // B. Ensure GroupBilling record exists
      await tx.groupBilling.upsert({
        where: { group_id: groupId },
        update: {
          plan_name: 'TRIAL',
          status: 'ok',
          retention_months: 12,
          included_sites: 1,
          active_sites_cnt: 1,
        },
        create: {
          group_id: groupId,
          plan_name: 'TRIAL',
          status: 'ok',
          retention_months: 12,
          included_sites: 1,
          active_sites_cnt: 1,
        },
      });

      // C. Ensure Site exists for this group
      let site;

      // State + derived timezone travel with every branch: an idempotent re-run that changes the
      // state also moves the timezone (the rates step lets a split-state garage correct it after).
      const stateData = sentState ? { state_code: sentState, timezone: stateTimezone ?? undefined } : {};

      if (siteId) {
        // Update the existing site for this user
        site = await tx.site.update({
          where: { id: siteId },
          data: {
            site_name: siteName ?? undefined,
            address: fullAddress ?? undefined,
            ...stateData,
          },
        });
      } else {
        // Try to reuse an existing site for this group if one exists
        const existingSite = await tx.site.findFirst({
          where: { group_id: groupId },
        });

        if (existingSite) {
          site = await tx.site.update({
            where: { id: existingSite.id },
            data: {
              site_name: siteName ?? undefined,
              address: fullAddress ?? undefined,
              ...stateData,
            },
          });
        } else {
          // Create the first site with the trading identity of the CHOSEN COUNTRY (the country step
          // ran first and wrote Group.country_code). No more hardcoded GBP/London — a US tenant gets
          // USD + an American default zone, IE gets EUR/Dublin, from the one profile.
          const grpForSite = (await tx.group.findUnique({ where: { id: groupId }, select: { country_code: true } })) as { country_code: string | null } | null;
          const prof = getProfile(grpForSite?.country_code);
          site = await tx.site.create({
            data: {
              group_id: groupId,
              site_name: siteName || 'Main Workshop',
              // State wins over the profile default when present (US) — Birmingham, Alabama gets
              // Chicago, not the profile's first zone.
              timezone: stateTimezone ?? prof.defaultTimezone,
              currency_code: prof.currency,
              locale: prof.locale,
              address: fullAddress ?? undefined,
              state_code: sentState ?? undefined,
              users: { connect: { id: dbUser.id } },
            },
          });
        }

        siteId = site.id;

        // Update user with default site
        await tx.user.update({
          where: { id: dbUser.id },
          data: { site_id: siteId },
        });
      }

      // Profit Centres are reporting tags now (not operationally required), so a new
      // Group+Site no longer needs one auto-created. Operational tree is Site → Resource.

      return {
        groupId,
        siteId,
      };
    });

    return res.status(201).json({
      message: 'Onboarding setup complete',
      groupId: result.groupId,
      siteId: result.siteId,
      redirectUrl: '/onboarding/rates-settings',
    });
  } catch (error) {
    console.error('Onboarding Setup Error:', error);

    let clientMessage =
      'Database Setup Error: The onboarding setup failed. Check server logs for details.';

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      clientMessage = `Database error: ${error.code}. An internal database constraint was violated.`;
    }

    return res.status(500).json({ message: clientMessage });
  }
}
