// File: pages/api/onboarding/invite-teams.ts - Agent Fix: 2025-12-14

import { NextApiRequest, NextApiResponse } from 'next';
import { PrismaClient } from '@prisma/client';
// FIX: Using Absolute Imports (@/lib) to prevent module resolution errors
import { requireAuthContext, AuthContext } from '@/lib/auth-context'; 
import { sendTeamInvitationEmail } from '@/lib/email-service'; 

const prisma = new PrismaClient();

// Validate email format
const isValidEmail = (email: string): boolean => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

// Central handler for POST requests, accepting AuthContext for security checks
async function handlePost(req: NextApiRequest, res: NextApiResponse, authContext: AuthContext) {
  // ✅ Security: Ensure user is admin or owner (multi-tenant SaaS requirement)
  if (authContext.role !== 'admin' && authContext.role !== 'owner') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  
  const { email, inviteLink } = req.body;
  
  // NOTE: Removed 'garageId' from destructuring as it is derived from AuthContext for security
  if (!email || !inviteLink) {
    return res.status(400).json({ error: 'Missing required fields: email, inviteLink' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Use the group/garage ID from the secure AuthContext
  const actualGarageId = authContext.groupId;
  if (!actualGarageId) {
       return res.status(403).json({ error: 'User is not assigned to a garage or group' });
  }

  try {
    // Check if user already exists in the garage (to prevent duplicate invites)
    const existingMember = await prisma.user.findFirst({
      where: {
        email,
        groupId: actualGarageId, // Use the authenticated group ID
      },
    });

    if (existingMember) {
      return res.status(409).json({ error: 'User already exists in this garage' });
    }

    // ✅ P.7 Notification System: Send invitation email
    const success = await sendTeamInvitationEmail(email, authContext.garageName || 'GreaseDesk Garage', inviteLink);

    if (!success) {
      // This is the error seen on the frontend: "Failed to send invitations"
      return res.status(500).json({ error: 'Failed to send invitation email' });
    }

    // Optionally, create a pending invite record in the DB
    // NOTE: Changed garageId to groupId to match multi-tenant logic
    await prisma.invite.create({
      data: {
        email,
        groupId: actualGarageId,
        inviteLink,
        createdAt: new Date(),
        status: 'pending',
      },
    });

    return res.status(200).json({ message: 'Team invitation sent successfully' });
  } catch (error) {
    console.error('Error processing invite:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Default export: Central handler that performs authentication
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Replaced API Key check with secure requireAuthContext
    const authContext = await requireAuthContext(req, res);
    return handlePost(req, res, authContext);
  } catch (error: any) {
    // Centralized authentication and permission error handling
    if (error.message === 'Not authenticated') {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (error.message.includes('not found') || error.message.includes('not assigned to a garage')) {
        return res.status(403).json({ error: error.message });
    }
    console.error('API Handler Error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}