/**
 * File: pages/api/onboarding/setup.ts
 * Description: FINAL WORKING VERSION: Resolves database unique constraints.
 * Last edited: 2025-11-13 at 18:57 Europe/London (FIXED - UPDATING EXISTING GROUP/CREATING SITE)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db'; 
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth'; 
import { authOptions } from '../auth/[...nextauth]'; 


export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    
    if (!session || !session.user || !session.user.email) {
        return res.status(401).json({ message: 'Authentication Error: Session not found.' });
    }

    // 1. Fetch User and their existing Group ID
    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, email: true, group_id: true }, // Ensure group_id is fetched
    });

    if (!user || !user.group_id) {
        // This is a safety check; should not happen if registration worked.
        return res.status(401).json({ message: `Authentication Error: User or Group not found.` });
    }
    
    const userId = user.id; 
    const groupId = user.group_id; // Use existing Group ID
    
    const { groupName, siteName, addressLine1, city, postcode } = req.body;
    
    // 🛑 STEP 1: Update Existing Group and Create Site (Using one transaction)
    
    // Set a transaction context explicitly for typing
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        
        // A. UPDATE the existing Group record (to add company details)
        const updatedGroup = await tx.group.update({
            where: { id: groupId }, // Use the existing Group ID
            data: {
                group_name: groupName,
            }
        });

        // B. Ensure Billing record exists (created during registration, but we ensure plan details)
        // Using upsert ensures it exists without violating unique constraints if somehow it was missed.
        const billing = await tx.groupBilling.upsert({
            where: { group_id: groupId },
            update: { 
                plan_name: "TRIAL", status: "ok", retention_months: 12, included_sites: 1, active_sites_cnt: 1
            },
            create: {
                group_id: groupId,
                plan_name: "TRIAL", status: "ok", retention_months: 12, included_sites: 1, active_sites_cnt: 1
            }
        });

        // C. CREATE the first Site record
        const newSite = await tx.site.create({
            data: {
                group_id: groupId,
                site_name: siteName, 
                timezone: "Europe/London", 
                currency_code: "GBP",      
                locale: "en-GB",           
                address: `${addressLine1}, ${city}, ${postcode}`,
                users: { connect: { id: userId } },
            }
        });
        
        // D. UPDATE the User with their new default Site ID
        await tx.user.update({
            where: { id: userId },
            data: {
                site_id: newSite.id,
            }
        });

        return { groupId, siteId: newSite.id };
    });

    // Success response...
    return res.status(201).json({ 
        message: 'Onboarding complete', 
        groupId: result.groupId,
        siteId: result.siteId
    });
  } catch (error) {
    console.error("Onboarding Setup Error:", error);
    // Use enhanced logging for better server debugging
    let clientMessage = 'Database Setup Error: The final user update failed. Check console for specific Prisma errors.';
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        clientMessage = `Database error: ${error.code}. An internal database constraint was violated.`;
    }
    return res.status(500).json({ message: clientMessage });
  }
}