/**
 * File: pages/api/auth/verify.ts
 * Last edited: 2025-11-02 at 21:40
 *
 * API for SaaS Onboarding Step 3.
 * FIX: Simplifies the redirect to the Admin Login page, passing data for auto-login attempt.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/db';

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).send('Invalid verification token.');
    }

    // 1. Find the token
    const verificationToken = await prisma.verificationToken.findUnique({
      where: { token },
    });

    if (!verificationToken) {
      return res.status(404).send('Token not found or already used.');
    }

    if (new Date() > new Date(verificationToken.expires)) {
      return res.status(410).send('Token expired.');
    }

    // 2. Mark the user as verified and delete the token
    const userEmail = verificationToken.identifier;
    
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { email: userEmail },
        data: { emailVerified: new Date() },
      });

      await tx.verificationToken.delete({
        where: { token },
      });
    });

    // 3. FINAL FIX: Redirect to the Admin Login page, passing the status.
    // This forces the user to manually enter their password, which creates the session.
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const callbackUrl = `${baseUrl}/onboarding/billing`; // Final destination after login

    res.redirect(
        302, 
        `${baseUrl}/admin/login?email=${encodeURIComponent(userEmail)}&status=verified&callbackUrl=${encodeURIComponent(callbackUrl)}`
    );

  } catch (error) {
    console.error('Email verification error:', error);
    return res.status(500).send('An unexpected error occurred during verification.');
  }
}