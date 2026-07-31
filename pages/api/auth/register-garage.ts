/**
 * File: pages/api/auth/register-garage.ts
 * Last edited: 2025-11-13 18:10 Europe/London (FINAL FIX - REMOVED LOCALHOST FALLBACK & ADDED EMAIL LOGO)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import * as bcrypt from 'bcryptjs';
import { UserRole, Prisma } from '@prisma/client';
import { sendNotification } from '@/lib/notify';
import crypto from 'crypto';
import { trialEndsFromNow } from '@/lib/trial';

type Payload = { name: string; email: string; password: string; ref?: string };

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
    const { name, email, password, ref } = (req.body || {}) as Payload;
    // Marketing attribution (dormant): sanitise + cap; never trust the client's raw value. null when absent.
    const signupRef = (typeof ref === 'string' ? ref.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) : '') || null;
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
    const { user, group } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const group = await tx.group.create({
        // ref is auto-assigned by the DB sequence default; status defaults to 'trial'.
        // group_name is a NEUTRAL placeholder, never the person's name — the onboarding site step
        // asks the real garage name and it's mandatory there (item-13). "Iain Gunn's Garage" was this
        // personal-name default surviving because setup used to be skippable; it no longer is.
        data: { group_name: 'New garage', billing_email: emailNorm, trial_ends_at: trialEndsFromNow(), signup_ref: signupRef },
      });

      const user = await tx.user.create({
        data: {
          name: name.trim(),
          email: emailNorm,
          passwordHash,
          role: UserRole.ADMIN, // primary subscriber
          is_owner: true,       // immutable owner of the new group
          group_id: group.id,
          is_active: true,
          emailVerified: null,
        },
        select: { id: true, email: true, name: true },
      });

      return { user, group };
    });

    // ATTRIBUTION (trigger 1 of 2): resolve the captured ?ref= NOW if a Rep already exists for it.
    // Best-effort and non-fatal — a resolution error must never fail a signup, and if no Rep matches
    // yet the raw signup_ref stays intact for the deferred path (resolveAttributionsForRep) to pick up
    // when that Rep is created. See lib/attribution.
    try {
      const { resolveAttribution } = await import('@/lib/attribution');
      await resolveAttribution(prisma, group.id);
    } catch (attrErr) {
      console.error('resolveAttribution at signup failed (non-fatal):', attrErr);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: { identifier: user.email, token, expires },
    });

    // 🛑 FIX: Use the Vercel variable or force the production domain.
    // This removes the stubborn 'localhost' fallback.
    const baseUrl = process.env.NEXTAUTH_URL || 'https://greasedesk.com'; 
    const verificationLink = `${baseUrl}/api/auth/verify?token=${token}`;
    
    // THROUGH THE CHOKEPOINT (2026-07-31). This was the last send with its own inline Resend
    // client and its own hand-rolled HTML — the first email a tenant ever receives, recorded
    // nowhere. It now names a template and writes a NotificationLog row like everything else.
    // Non-fatal by design: a signup must never fail because an email didn't go.
    const notified = await sendNotification({
      recipient: user.email,
      template: 'signup_verify',
      channel: 'email',
      groupId: group.id,
      subject: { type: 'user', id: user.id },
      data: { name: user.name || 'there', link: verificationLink },
    });
    if (!notified.ok) console.warn('[register] verification email not sent:', notified.status, notified.reason, verificationLink);

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