/**
 * File: pages/api/auth/verify.ts
 * Last edited: 2025-11-13 at 17:25 Europe/London (FIXED - USER-FRIENDLY ERROR REDIRECT)
 *
 * API for SaaS Onboarding Step 3.
 * FIX: Simplifies the redirect to the Admin Login page, passing data for auto-login attempt.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '../../../lib/db'; 
import { Prisma } from '@prisma/client';

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const token = req.query.token as string | undefined;
  const baseUrl = process.env.NEXTAUTH_URL || 'https://greasedesk.com'; // Use the confirmed production fallback

  // Function to redirect to a user-friendly error page
  const redirectToErrorPage = (errorCode: 'invalid' | 'used' | 'expired' | 'server') => {
    return res.redirect(302, `${baseUrl}/onboarding/verify-status?error=${errorCode}`);
  };

  try {
    if (!token) {
      // 🛑 Friendly Redirect on Invalid Token Format
      return redirectToErrorPage('invalid');
    }

    // 1. Find the token
    const verificationToken = await prisma.verificationToken.findUnique({
      where: { token },
    });

    if (!verificationToken) {
      // 🛑 Friendly Redirect on Token Not Found (or already used/deleted)
      return redirectToErrorPage('used');
    }

    if (new Date() > new Date(verificationToken.expires)) {
      // 🛑 Friendly Redirect on Token Expired
      // We don't delete the token here, as the user might want a link sent again
      return redirectToErrorPage('expired');
    }

    // 2. Mark the user as verified and delete the token
    const userEmail = verificationToken.identifier;
    
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.user.update({
        where: { email: userEmail },
        data: { emailVerified: new Date() },
      });

      await tx.verificationToken.delete({
        where: { token },
      });
    });

    // 3. SUCCESS: Redirect to the Admin Login page
    const callbackUrl = `${baseUrl}/onboarding/billing`; // Final destination after login

    return res.redirect(
        302, 
        `${baseUrl}/admin/login?email=${encodeURIComponent(userEmail)}&status=verified&callbackUrl=${encodeURIComponent(callbackUrl)}`
    );
  } catch (error) {
    console.error('Email verification error:', error);
    // 🛑 Friendly Redirect on Unexpected Server Error
    return redirectToErrorPage('server');
  }
}