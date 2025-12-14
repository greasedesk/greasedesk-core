/**
 * File: pages/api/onboarding/invite-team.ts
 * Helper: Process team member invitations with proper authentication context
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { requireAuthContext } from '@/lib/auth-context';

// Helper type for invitation response
type InvitationResponse = {
  success: boolean;
  message: string;
  count?: number;
  error?: string;
};

/**
 * API Route: Handle team member invitations
 * Requires authentication and proper context
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<InvitationResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    // Require authenticated context
    const authContext = await requireAuthContext(req, res);
    
    // Validate request body
    const { invites } = req.body;
    
    if (!invites || !Array.isArray(invites) || invites.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No valid invitations provided.' 
      });
    }

    // Prepare data for batch creation
    const usersToCreate = invites.map(invite => ({
      email: invite.email.toLowerCase(),
      role: invite.role,
      group_id: authContext.groupId, // Use correct field name
      site_id: authContext.siteId,
      is_active: false,
      emailVerified: null,
      passwordHash: 'INVITE_PENDING', 
    }));

    // Transaction to create multiple new User records
    const createdUsers = await prisma.$transaction(
      usersToCreate.map(data => 
        prisma.user.upsert({
          where: { email: data.email },
          update: { 
            role: data.role,
            site_id: data.site_id,
            group_id: data.group_id, // Use correct field name
          },
          create: data,
        })
      )
    );

    // Return success response
    return res.status(200).json({ 
      success: true, 
      message: 'Invitations processed and pending user accounts created.',
      count: createdUsers.length 
    });

  } catch (error: any) {
    // Handle errors
    console.error('Invite Team API Error:', error);
    
    // If the error is from the database, check for specific issues
    if (error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'Conflict: User with this email already exists.',
        error: error.message
      });
    }
    
    // General error
    return res.status(500).json({
      success: false,
      message: 'Failed to process invitations due to a server error.',
      error: error.message
    });
  }
}