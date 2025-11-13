/**
 * File: pages/api/onboarding/create-billing.ts
 * Last edited: 2025-11-13 at 12:28 Europe/London (FIXED - ADDED PLACEHOLDER STATUS)
 *
 * API for SaaS Onboarding Step 5: Create Billing Record.
 * This API is called after the "fake" credit card form.
 * It creates the GroupBilling record and starts the trial.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '../../../lib/db';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { BillingStatus } from '@prisma/client';

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
      return res.status(401).json({ message: 'You must be logged in to start a trial.' });
    }

    const { group_id } = session.user;

    // 2. Check if a billing record already exists for this group
    const existingBilling = await prisma.groupBilling.findUnique({
      where: { group_id: group_id },
    });

    if (existingBilling) {
      // If it already exists, just return success.
      return res.status(200).json({ message: 'Billing record already exists.', status: 'already_active' });
    }
    
    // 3. Create the new billing record (Start the 60-day trial)
    await prisma.groupBilling.create({
      data: {
        group_id: group_id,
        plan_name: 'Core Basic', // From your blueprint's pricing plan
        status: BillingStatus.grace, // Using 'grace' for the trial period
        retention_months: 3, // From your "Core Basic" plan
        included_sites: 1, // From your "Core Basic" plan
        active_sites_cnt: 1,
      },
    });

    // 🌟 PLACEHOLDER ADDED: Return a specific status for the client-side onboarding flow
    return res.status(201).json({ message: 'Trial started successfully.', status: 'trial_started' });

  } catch (error) {
    console.error('Billing creation error:', error);
    return res.status(500).json({ message: 'An unexpected error occurred.', status: 'error' });
  }
}