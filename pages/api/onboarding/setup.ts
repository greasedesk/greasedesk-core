/**
 * File: pages/api/onboarding/setup.ts
 * Description: FINAL WORKING VERSION: Resolves all database constraints and naming issues.
 * Last edited: 2025-11-13 at 12:30 Europe/London (FINAL FINAL FIX)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
// 💥 FINAL FIX: Changed from default import to named import to resolve the Type Error.
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

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, email: true },
    });

    if (!user) {
        return res.status(401).json({ message: `Authentication Error: User not found in DB for email: ${session.user.email}` });
    }
    
    const userId = user.id; 
    const userEmail = user.email;

    const { groupName, siteName, addressLine1, city, postcode } = req.body;
    
    // 🛑 STEP 1: Create Group, Site, and Billing (This part is now working)
    const newGroup = await prisma.group.create({
        data: {
            group_name: groupName,
            billing_email: userEmail,
            users: { connect: { id: userId } },
            billing: {
                create: { plan_name: "TRIAL", status: "ok", retention_months: 12, included_sites: 1, active_sites_cnt: 1 }
            },
            sites: {
                create: {
                    site_name: siteName, 
                    timezone: "Europe/London", 
                    currency_code: "GBP",      
                    locale: "en-GB",           
                    address: `${addressLine1}, ${city}, ${postcode}`,
                    users: { connect: { id: userId } },
                }
            }
        },
        include: {
            sites: { select: { id: true } }
        }
    });

    const newSiteId = newGroup.sites[0].id;

    // 🛑 STEP 2: FIX FINAL ERROR
    // We update the relationships using 'group' and 'site' (the relation names),
    // and tell Prisma to connect them using the ID.
    await prisma.user.update({
        where: { id: userId },
        data: {
            // ✅ FIX 1: Change 'groupId' to 'group' and use the connect operation
            group: { connect: { id: newGroup.id } },
            // ✅ FIX 2: Change 'siteId' to 'site' and use the connect operation
            site: { connect: { id: newSiteId } },
        }
    });
    
    // Success response...
    return res.status(201).json({ 
        message: 'Onboarding complete', 
        groupId: newGroup.id,
        siteId: newSiteId 
    });
  } catch (error) {
    console.error("Onboarding Setup Error:", error);
    return res.status(500).json({ message: 'Database Setup Error: The final user update failed. Check console for specific Prisma errors.' });
  }
}