/**
 * File: pages/api/admin/settings/update.ts...
 * Description: API route to save core operational and financial defaults for the user's active Site/Group.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '@/lib/db'; 
import { getServerSession } from 'next-auth'; 
import { authOptions } from '@/pages/api/auth/[...nextauth]'; // <-- FIX: Changed to absolute path alias to resolve "Cannot find module" error
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client'; 

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // --- 1. Authentication and Authorization ---
  // The 'user as any' cast is retained to prevent the UserRole error we fixed earlier, 
  // but the code now relies on the custom types you are currently defining.
  const session = await getServerSession(req, res, authOptions);
    
  const user = session?.user as any; 
  if (!user || !user.group_id || !user.site_id) {
      return res.status(401).json({ message: 'Authentication Error: Group/Site context not found in session. Please re-login.' });
  }
  
  try {
    const { 
      defaultVatRate, 
      defaultLabourRate, 
      timezone, 
      currencyCode,
      pricingDisplayMode,
      // ✅ CORRECTED FIELDS FROM FRONTEND
      supportedCountries,
      supportedCurrencies
    } = req.body;

    const groupId = user.group_id;
    const siteId = user.site_id;

    // --- 2. Database Transaction for Atomicity ---
    // The explicit typing of tx is retained from the pre-emptive fix.
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        
        // 2a. Update the Site record with regional settings and lists
        await tx.site.update({
            where: { id: siteId, group_id: groupId },
            data: {
                timezone: timezone,
                currency_code: currencyCode,
                pricing_display_mode: pricingDisplayMode, 
                // ✅ SAVE ARRAYS TO JSON FIELDS
                supported_countries: supportedCountries, // Updated field name
                supported_currencies: supportedCurrencies,
            },
        });

        // 2b. Update/Create Default VAT Tax Rate (Linked to Group)
        await tx.taxRate.upsert({
            where: { id: groupId + "-DEFAULT-VAT" }, 
            update: {
                percentage: new Decimal(defaultVatRate),
                valid_from: new Date(),
            },
            create: {
                id: groupId + "-DEFAULT-VAT",
                group_id: groupId,
                name: "Standard VAT Rate",
                percentage: new Decimal(defaultVatRate),
                valid_from: new Date(),
            }
        });

        // 2c. Update/Create Default Labour Service (Linked to Site)
        await tx.serviceCatalogue.upsert({
            where: { id: siteId + "-DEFAULT-LABOUR" },
            update: {
                default_labour_rate: new Decimal(defaultLabourRate),
            },
            create: {
                id: siteId + "-DEFAULT-LABOUR",
                group_id: groupId,
                site_id: siteId,
                name: "Standard Labour Rate",
                service_code: "LAB01",
                default_labour_rate: new Decimal(defaultLabourRate),
                default_price: new Decimal(defaultLabourRate),
                vat_rate: new Decimal(defaultVatRate), 
            }
        });

    });

    // --- 3. Success Response ---
    return res.status(200).json({ message: 'Settings saved successfully!' });

  } catch (error) {
    console.error("Settings Update Error:", error);
    return res.status(500).json({ message: 'Failed to save settings. Check TaxRate/ServiceCatalogue unique keys in console.' });
  }
}