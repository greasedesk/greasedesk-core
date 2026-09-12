/**
 * File: pages/api/pwa/clock.ts
 * CLOCK ON / CLOCK OFF, from the phone. POST { action, jobCardId?, deviceAt?, idempotencyKey? }.
 *
 * ── WHOSE TIME IT IS ────────────────────────────────────────────────────────────────────────────
 * The session's user, never a body field. A tech cannot clock somebody else on, and the endpoint
 * offers no way to try. See THE OPEN QUESTION in lib/job-clock-store's caller notes and the owner's
 * open item: a 90-day session on a shared workshop phone attributes work to whoever is holding it.
 *
 * ── THE JOB CARD MUST BE THEIRS ─────────────────────────────────────────────────────────────────
 * Scoped by group_id, like every tenant read. A clock-on naming another garage's card is a 404, not
 * a 403 — the same undiscoverability the rest of the app uses.
 *
 * ── deviceAt IS THE OFFLINE CASE, AND IT IS LABELLED ────────────────────────────────────────────
 * When the outbox delivers a clock-on captured with no signal, the instant is the DEVICE's. It is
 * accepted, recorded as `queued`, kept beside the server's receipt time, and clamped if the phone
 * claims the future. Nothing is averaged; a session whose clocks disagree wildly renders as
 * disputed rather than as hours (lib/job-clock).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { clockOn, clockOff, openSessionFor } from '@/lib/job-clock-store';

/** A device instant, or null. Rejected rather than coerced if it is not a real date. */
function deviceInstant(raw: unknown): Date | null | 'bad' {
  if (raw == null || raw === '') return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? 'bad' : d;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as { id?: string; group_id?: string } | undefined;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const b = (req.body || {}) as Record<string, unknown>;
  const action = String(b.action ?? '');
  if (action !== 'on' && action !== 'off') return res.status(400).json({ message: 'action must be "on" or "off".' });

  const claimed = deviceInstant(b.deviceAt);
  // A BAD DATE IS 400 AND TERMINAL. The outbox treats 400 as terminal and stops retrying — right
  // here: a malformed instant will never become well-formed, and an item that retries forever is
  // the queue never emptying.
  if (claimed === 'bad') return res.status(400).json({ message: 'deviceAt is not a date.' });

  if (action === 'off') {
    const out = await clockOff({ userId: user.id, deviceAt: claimed });
    return res.status(200).json({ ok: true, closed: out.closed, clamped: out.clamped });
  }

  const jobCardId = String(b.jobCardId ?? '');
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required to clock on.' });
  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, vehicle: { select: { registration: true } } },
  });
  if (!card) return res.status(404).json({ message: 'Not found.' });

  // WHAT THEY WERE ON, read BEFORE the write, so the answer can name the car they have just been
  // moved off. Afterwards it is gone, and "you were moved off something" is not a useful sentence.
  const wasOn = await openSessionFor(user.id);
  const previous = wasOn && wasOn.job_card_id !== jobCardId
    ? await prisma.jobCard.findUnique({ where: { id: wasOn.job_card_id }, select: { vehicle: { select: { registration: true } } } })
    : null;

  const out = await clockOn({ groupId: user.group_id, userId: user.id, jobCardId: card.id, deviceAt: claimed });
  return res.status(200).json({
    ok: true, id: out.id, clamped: out.clamped,
    supersededCount: out.supersededCount,
    supersededReg: previous?.vehicle?.registration ?? null,
  });
}
