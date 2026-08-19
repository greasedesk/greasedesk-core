/**
 * File: pages/api/intake-respond.ts
 * THE CUSTOMER'S ANSWER to one finding on an intake report.
 *
 *   POST { token, dueItemId, answer: 'yes' | 'no' | 'call_me' }
 *
 * Token-authenticated, no session — the link IS the credential, exactly as it is for a quote. The
 * purpose is checked, so a quote or invoice link cannot answer findings.
 *
 * ── "YES" IS NOT AN ACCEPTANCE ──────────────────────────────────────────────────────────────────
 * The report carries no prices, so nothing here can commit a customer to a figure. A yes records
 * INTEREST (`agreed_later` on the garage's side) and the estimate still goes out and comes back
 * through acceptQuote — the one acceptance path, with its frozen version and its audit.
 *
 * ── AND IT CANNOT LEAK ACROSS CARS ──────────────────────────────────────────────────────────────
 * The finding must belong to the vehicle on the link's own job card. A token names a card; without
 * that check a valid token could answer any finding in the tenant.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveMagicLink } from '@/lib/magic-link';
import { clientIp } from '@/lib/auth-rate-limit';
import { recordCustomerAnswer, type CustomerAnswer } from '@/lib/due-items';
import { writeAudit } from '@/lib/audit';

const ANSWERS: readonly CustomerAnswer[] = ['yes', 'no', 'call_me'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { token, dueItemId, answer } = (req.body ?? {}) as { token?: string; dueItemId?: string; answer?: CustomerAnswer };
  if (!token || !dueItemId || !answer || !ANSWERS.includes(answer)) {
    return res.status(400).json({ message: 'A token, an item and an answer are required.' });
  }

  const ip = clientIp(req.headers as any);
  const resolved = await resolveMagicLink(token, { purpose: 'intake_report', ip, recordUse: false });
  if (!resolved.ok) {
    const code = resolved.reason === 'expired' ? 410 : resolved.reason === 'rate_limited' ? 429 : 404;
    return res.status(code).json({ message: 'This report link is no longer valid.', reason: resolved.reason });
  }

  // THE FINDING MUST BELONG TO THIS LINK'S CAR. Resolved through the card the token names, never
  // taken from the request.
  const card = await prisma.jobCard.findUnique({
    where: { id: resolved.link.jobCardId },
    select: { vehicle_id: true, group_id: true },
  });
  const item = card && await prisma.vehicleDueItem.findFirst({
    where: { id: dueItemId, group_id: resolved.link.groupId, vehicle_id: card.vehicle_id, closed_at: null },
    select: { id: true },
  });
  if (!item) return res.status(404).json({ message: 'That item is no longer on this report.' });

  const at = new Date();
  const { garageResponse } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // THE ONE WRITER (lib/due-items::recordCustomerAnswer): appends the customer's own record and
    // writes through to the garage's field, in one transaction so the two can never be written apart.
    const r = await recordCustomerAnswer(tx, {
      groupId: resolved.link.groupId, dueItemId, answer, magicLinkId: resolved.link.id, at,
    });
    await writeAudit(tx, {
      groupId: resolved.link.groupId,
      // NO userId — a customer is not a user. The magic link is the attribution.
      userId: null,
      entity: 'VehicleDueItem', entityId: dueItemId,
      action: 'due_item.customer_answered',
      diff: { answer, via: 'intake_report', magicLinkId: resolved.link.id },
    });
    return r;
  });

  // Re-answering is idempotent in effect and honest in the record: the append leaves both taps.
  return res.status(200).json({ ok: true, answer, garageResponse });
}
