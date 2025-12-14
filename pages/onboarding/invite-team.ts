/**
 * File: pages/api/onboarding/invite-team.ts
 * last edited 
 * Description: API to receive team member invites, create pending user records, and send emails.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { Prisma, UserRole } from '@prisma/client';
import crypto from 'crypto';
// NOTE: We will skip the actual email sending logic (using Resend) for now 
// and focus on database creation, but you will integrate the email API here later.

interface InvitePayload {
    invites: { email: string; role: 'STAFF' | 'MECHANIC' }[];
}

export default async function handle(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const session = await getServerSession(req, res, authOptions);
    const user = session?.user as any;

    // 1. Authentication and Context Check
    if (!user?.group_id || !user?.site_id) {
        return res.status(401).json({
            message: 'Unauthorized: Session or site context is missing.',
        });
    }

    const groupId = user.group_id;
    const siteId = user.site_id;
    const { invites } = req.body as InvitePayload;

    if (!invites || invites.length === 0) {
        return res.status(400).json({ message: 'No valid invitations provided.' });
    }

    // Prepare data for batch creation
    const usersToCreate = invites.map(invite => ({
        email: invite.email.toLowerCase(),
        role: invite.role,
        group_id: groupId,
        site_id: siteId,
        // New users start inactive, pending verification/setup
        is_active: false, 
        emailVerified: null,
        // Since they don't have a password yet, we use a placeholder:
        passwordHash: 'INVITE_PENDING', 
    }));

    try {
        // 2. Transaction to create multiple new User records
        const createdUsers = await prisma.$transaction(
            usersToCreate.map(data => 
                prisma.user.upsert({
                    where: { email: data.email },
                    update: { 
                        // If user already exists, update their role/site details based on the admin invite
                        role: data.role,
                        site_id: data.site_id,
                        group_id: groupId, // FIXED: Using groupId from session context
                    },
                    create: data,
                })
            )
        );

        // 3. (Future Step): Loop through createdUsers and send invitation emails.

        return res.status(200).json({ 
            message: 'Invitations processed and pending user accounts created.',
            count: createdUsers.length,
        });

    } catch (error: any) {
        // P2002 error here would mean a unique constraint failed (e.g., trying to create a user 
        // with an existing non-email unique field if added later)
        console.error('Invite Team API Error:', error);
        return res.status(500).json({
            message: 'Failed to process invitations due to a server error.',
        });
    }
}