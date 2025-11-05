/**
 * File: pages/api/auth/register-garage.ts
 * Last edited: 2025-11-02 at 21:48
 *
 * API for SaaS Onboarding Step 1.
 * FINAL FIX: Removed React email component dependency to stabilize email sending.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '../../../lib/db';
import { hash } from 'bcrypt';
import { UserRole } from '@prisma/client';
import { Resend } from 'resend';
import crypto from 'crypto';
// Removed: import { VerificationEmail } from '../../../components/emails/VerificationEmail';
// Removed: import { render } from '@react-email/render'; 

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const { email, password, name } = req.body;

    // --- 1. Validation (Unchanged) ---
    if (!email || !password || !name) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({ message: 'A user with this email already exists.' });
    }

    // --- 2. Create Group and User (Unchanged) ---
    const hashedPassword = await hash(password, 12);

    const { newUser } = await prisma.$transaction(async (tx) => {
      const newGroup = await tx.group.create({
        data: { group_name: `${name}'s Garage`, billing_email: email.toLowerCase() },
      });

      const user = await tx.user.create({
        data: {
          email: email.toLowerCase(),
          name: name,
          passwordHash: hashedPassword,
          role: UserRole.STAFF,
          group_id: newGroup.id,
          is_active: true,
          emailVerified: null, 
        },
      });
      return { newUser: user };
    });

    // --- 3. Create Verification Token (Unchanged) ---
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: { identifier: newUser.email, token: token, expires: expires },
    });

    // --- 4. Send Verification Email (THE FINAL, STABLE FIX) ---
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const verificationLink = `${baseUrl}/api/auth/verify?token=${token}`;
    const userName = newUser.name || 'New User';

    const emailHtml = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify Your Email</title>
        </head>
        <body style="font-family: Arial, sans-serif; background-color: #f6f9fc; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 8px; border: 1px solid #e6e6e6;">
            <h1 style="color: #1e3a8a; font-size: 24px; text-align: center;">Welcome to GreaseDesk!</h1>
            <p style="color: #333; font-size: 16px;">Hi ${userName},</p>
            <p style="color: #333; font-size: 16px;">
              Thank you for signing up. To start your 30-day free trial, please verify
              your email address by clicking the button below:
            </p>
            <div style="text-align: center; margin-top: 30px;">
              <a href="${verificationLink}" style="background-color: #3b82f6; border-radius: 6px; color: #fff; font-size: 16px; font-weight: bold; text-decoration: none; padding: 12px 20px; display: inline-block;">
                Verify Email Address
              </a>
            </div>
            <p style="color: #555; font-size: 14px; margin-top: 30px; text-align: center;">
              If the button doesn't work, copy and paste this link into your browser:
            </p>
            <p style="word-break: break-all; font-size: 12px; color: #1e40af; text-align: center;">${verificationLink}</p>
            <hr style="border-top: 1px solid #e6ebf1; margin-top: 20px;" />
            <p style="color: #999; font-size: 12px; text-align: center;">
              GreaseDesk Ltd. | You received this email because you signed up for a free trial.
            </p>
          </div>
        </body>
      </html>
    `;
    
    const { data, error } = await resend.emails.send({
      from: 'Onboarding <onboarding@greasedesk.com>', 
      to: [newUser.email],
      subject: 'Welcome to GreaseDesk! Please verify your email',
      html: emailHtml,
    });

    if (error) {
      console.error('Email sending failed:', error);
      return res.status(500).json({ message: 'Error sending verification email. Please try again.'});
    }

    // --- 5. Success ---
    return res.status(201).json({ 
      message: 'Account created. Please check your email to verify.',
      userEmail: newUser.email,
    });

  } catch (error) {
    console.error('Garage Registration error:', error);
    return res.status(500).json({ message: 'An unexpected error occurred.' });
  }
}