/**
 * File: pages/api/auth/register-garage.ts
 * Last edited: 2025-11-13 16:05 Europe/London (FINAL FIX - SWITCH TO BCRYPTJS)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
// 💥 FIX: Switched from 'import bcrypt from 'bcrypt'' to 'import * as bcrypt from 'bcryptjs'' 
// to resolve the native build error (No native build was found...).
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

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const verificationLink = `${baseUrl}/api/auth/verify?token=${token}`;
    const html = `
      <!doctype html><html><body style="font-family:Arial,sans-serif">
      <h2>Welcome to GreaseDesk</h2>
      <p>Hi ${user.name || 'there'}, verify your email to start your trial:</p>
      <p><a href="${verificationLink}">Verify Email</a></p>
      <p style="word-break:break-all;font-size:12px;color:#555">${verificationLink}</p>
      </body></html>
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