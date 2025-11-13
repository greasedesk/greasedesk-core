/**
 * File: pages/api/onboarding/finalize-setup.ts
 * Last edited: 2025-11-13 at 12:28 Europe/London (FINAL FIX)
 *
 * API for SaaS Onboarding Step 5: Final Setup.
 * Creates the Group, Site, and ProfitCentre records.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
// 💥 FINAL FIX: Changed from default import to named import to resolve the Type Error.
import { prisma } from '../../../lib/db';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { Prisma } from '@prisma/client'; // <-- FIX 1: Import Prisma namespace for typing

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    // 1. Get the logged-in user's session (SECURE)
    const session = await getServerSession(req, res, authOptions);

    if (!session || !session.user || !session.user.group_id) {
      return res.status(401).json({ message: 'Authentication required to finalize setup.' });
    }

    // Get group_id from session (the owner's master account)
    const { group_id, id: user_id } = session.user;
    const { groupData, siteData, pcData } = req.body;

    // 2. Run a Transaction to Update Group, Create Site, and Create Profit Centre
    // <-- FIX 2: Explicitly type 'tx' as Prisma.TransactionClient
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        
        // A. Update the existing Group record (created during the registration step)
        const updatedGroup = await tx.group.update({
            where: { id: group_id },
            data: {
                group_name: groupData.group_name,
                company_number: groupData.company_number,
                vat_number: groupData.vat_number,
                address: groupData.address,
            },
        });

        // B. Create the new Site record (Blueprint: Site Entity)
        const newSite = await tx.site.create({
            data: {
                group_id: group_id,
                site_name: siteData.site_name,
                timezone: siteData.timezone,
                currency_code: siteData.currency_code,
                locale: siteData.locale,
                is_active: true,
                // Inherit legal info from the Group if not provided here
                company_number: groupData.company_number,
                vat_number: groupData.vat_number,
            }
        });

        // C. Update the User with their new default Site ID
        // This is crucial for multi-tenancy filtering in the main app
        await tx.user.update({
            where: { id: user_id },
            data: {
                site_id: newSite.id,
            }
        });

        // D. Create the first Profit Centre (Blueprint: Profit Centre Entity)
        const newPc = await tx.profitCentre.create({
            data: {
                site_id: newSite.id,
                name: pcData.name,
                is_active: true,
            }
        });
        
        return { site: newSite, pc: newPc };
    });

    return res.status(201).json({ message: 'Setup finalized successfully.', siteId: result.site.id });

  } catch (error) {
    console.error('Setup Finalization Error:', error);
    // Return a generic 500 error to the client
    return res.status(500).json({ message: 'An unexpected error occurred during setup.' });
  }
}