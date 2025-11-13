/**
 * File: pages/api/auth/register-garage.ts
 * Last edited: 2025-11-13 18:10 Europe/London (FINAL FIX - REMOVED LOCALHOST FALLBACK & ADDED EMAIL LOGO)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import * as bcrypt from 'bcryptjs';
import { UserRole, Prisma } from '@prisma/client';
import { Resend } from 'resend';
import crypto from 'crypto';

type Payload = { name: string; email: string; password: string };

export const config = {
  api: { bodyParser: true },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Always declare JSON so clients don’t try to parse as something else.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // ── Probe mode to prove client parsing is fine (set DEBUG_REGISTER_PROBE=1)
  if (process.env.DEBUG_REGISTER_PROBE === '1') {
    return res
      .status(200)
      .json({ ok: true, where: 'probe', hint: 'Disable DEBUG_REGISTER_PROBE to run full flow.' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res
      .status(405)
      .json({ ok: false, where: 'method-guard', message: `Method ${req.method} Not Allowed` });
  }

  try {
    const { name, email, password } = (req.body || {}) as Payload;
    // ... (Validation logic remains unchanged) ...
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, where: 'validate', message: 'Name, email and password are required.' });
    }
    const emailNorm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
      return res
        .status(400)
        .json({ ok: false, where: 'validate', message: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ ok: false, where: 'validate', message: 'Password must be at least 8 characters.' });
    }

    const existing = await prisma.user.findUnique({ where: { email: emailNorm } });
    if (existing) {
      return res
        .status(409)
        .json({ ok: false, where: 'unique', message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // ... (Prisma transaction logic remains unchanged) ...
    const { user } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const group = await tx.group.create({
        data: { group_name: `${name}'s Garage`, billing_email: emailNorm },
      });

      const user = await tx.user.create({
        data: {
          name: name.trim(),
          email: emailNorm,
          passwordHash,
          role: UserRole.STAFF,
          group_id: group.id,
          is_active: true,
          emailVerified: null,
        },
        select: { id: true, email: true, name: true },
      });

      return { user };
    });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: { identifier: user.email, token, expires },
    });

    // 🛑 FIX: Use the Vercel variable or force the production domain.
    // This removes the stubborn 'localhost' fallback.
    const baseUrl = process.env.NEXTAUTH_URL || 'https://greasedesk.com'; 
    const verificationLink = `${baseUrl}/api/auth/verify?token=${token}`;
    
    // Use the public domain URL for the logo (must be HTTPS)
    const logoUrl = `${baseUrl}/email-logo.png`; 
    
    const html = `
      <!doctype html>
      <html lang="en">
      <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0;">
          <div style="max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);">
              
              <div style="background-color: #ffffff; padding: 20px; text-align: center; border-top-left-radius: 8px; border-top-right-radius: 8px;">
                  <img src="${logoUrl}" alt="GreaseDesk Logo" style="max-height: 40px; width: 150px; height: auto;"/>
              </div>
              
              <div style="padding: 30px; border-top: 5px solid #007bff;">
                  <p style="font-size: 16px; color: #333333; margin-bottom: 20px;">
                      Hi ${user.name || 'there'},
                  </p>
                  <p style="font-size: 16px; color: #333333; margin-bottom: 30px;">
                      Thank you for signing up! To activate your **GreaseDesk trial** and continue setting up your garage system, please click the button below to verify your email address.
                  </p>
                  
                  <div style="text-align: center; margin: 30px 0;">
                      <a href="${verificationLink}" 
                         style="background-color: #28a745; 
                                color: #ffffff; 
                                text-decoration: none; 
                                padding: 12px 25px; 
                                border-radius: 5px; 
                                font-size: 18px; 
                                font-weight: bold; 
                                display: inline-block;">
                          Verify Email Address
                      </a>
                  </div>
                  
                  <p style="font-size: 14px; color: #666666; margin-top: 25px;">
                      If the button above does not work, please copy and paste the link below into your web browser:
                  </p>
                  <p style="font-size: 12px; color: #999999; word-break: break-all; margin-bottom: 0;">
                      <a href="${verificationLink}" style="color: #007bff;">${verificationLink}</a>
                  </p>
              </div>

              <div style="text-align: center; padding: 15px; font-size: 12px; color: #999999; border-top: 1px solid #eeeeee;">
                  This email was sent by GreaseDesk.
              </div>
          </div>
      </body>
      </html>
    `;

    try {
      const apiKey = process.env.RESEND_API_KEY;
      if (apiKey) {
        const resend = new Resend(apiKey);
        const { error } = await resend.emails.send({
          from: 'Onboarding <onboarding@greasedesk.com>',
          to: [user.email],
          subject: 'Welcome to GreaseDesk — verify your email',
          html,
        });
        if (error) console.error('Resend send error:', error);
      } else {
        console.warn('RESEND_API_KEY not set; skipping email send:', verificationLink);
      }
    } catch (mailErr) {
      console.error('Email send threw:', mailErr);
    }

    return res.status(201).json({
      ok: true,
      where: 'success',
      message: 'Account created. Please check your email to verify.',
      user,
    });
  } catch (err: any) {
    // ENHANCED LOGGING: Now includes Prisma and generic errors
    console.error('register-garage FATAL ERROR:', err);
    
    let clientMessage = 'Registration failed due to a server error (check console).';

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        clientMessage = `Database error: ${err.code}. Check your schema constraints.`;
    } else if (typeof err?.message === 'string') {
        clientMessage = err.message;
    }
    
    return res.status(500).json({ ok: false, where: 'catch', message: clientMessage });
  }
}