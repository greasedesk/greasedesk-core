/**
 * File: pages/api/jobcard-stock-prep.ts
 *
 * Mark a job card as preparing a car WE OWN, or hand it back to being a customer card.
 * PATCH { jobCardId, stockItemId | null }.
 *
 * Shaped on jobcard-comeback, which is the same kind of decision: an operational person recognises
 * what a card IS, and the flag changes where its money goes. Operational authority for that reason —
 * the mechanic prepping the car is the one who knows.
 *
 * The link is the flag (see lib/stock-prep), so this endpoint IS the toggle. Audited both ways,
 * because moving work off a customer's bill and onto our own stock is a money decision.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { canAccessSite, requireTenantApi } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  // THE CHOKEPOINT, not a copy of it. jobcard-comeback still reads the session by hand — this route
  // is new, so it goes through the validator, and scope.vis is the same visibility that hand-rolled
  // pattern was fetching separately.
  const scope = await requireTenantApi(req, res);
  if (!scope) return; // it has already answered 401

  const { jobCardId, stockItemId } = (req.body || {}) as { jobCardId?: string; stockItemId?: string | null };
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });
  const wanted = typeof stockItemId === 'string' && stockItemId ? stockItemId : null;

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: scope.groupId },
    select: { id: true, site_id: true, vehicle_id: true, stock_item_id: true, invoice: { select: { id: true } } },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  if (!canAccessSite(scope.vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  if (card.stock_item_id === wanted) return res.status(200).json({ message: 'No change.' }); // idempotent

  /**
   * AN INVOICED CARD CANNOT BECOME INTERNAL. The invoice is a frozen document with a real number out
   * of a gapless series; moving its work onto our own stock afterwards would leave a customer holding
   * a bill for parts the stock book also counts as ours. Voiding the invoice is the way back, and it
   * is a deliberate, audited act rather than a side effect of ticking a box.
   */
  if (wanted && card.invoice) {
    return res.status(409).json({
      message: 'This card has been invoiced, so it cannot become internal prep. Void the invoice first '
        + 'if it was raised in error — that keeps the document and retires the number.',
    });
  }

  if (wanted) {
    const item = await prisma.stockItem.findFirst({
      where: { id: wanted, group_id: scope.groupId },
      select: { id: true, vehicle_id: true, disposal: { select: { id: true } } },
    });
    if (!item) return res.status(404).json({ message: 'That stock record is not on this account.' });
    // THE CARD AND THE STOCK ITEM MUST BE THE SAME CAR. Without this, prep on one car accrues to
    // another's cost base and both margins are wrong with nothing on either to show it.
    if (item.vehicle_id !== card.vehicle_id) {
      return res.status(409).json({ message: 'That stock record is for a different car.' });
    }
    if (item.disposal) {
      return res.status(409).json({
        message: 'That car has already been sold. Its costs were frozen at disposal, so new work cannot '
          + 'be added to it — re-running an old quarter has to give what it gave then.',
      });
    }
  }

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({ where: { id: jobCardId }, data: { stock_item_id: wanted } });
      await writeAudit(tx, {
        groupId: scope.groupId, userId: scope.userId, jobCardId,
        action: wanted ? 'stock_prep.linked' : 'stock_prep.unlinked',
        diff: { stockItemId: { from: card.stock_item_id, to: wanted } },
      });
    });
  } catch (e) {
    console.error('stock prep link error:', e);
    return res.status(500).json({ message: 'Could not update this card.' });
  }
  return res.status(200).json({ message: wanted ? 'This card is now internal prep.' : 'This card bills the customer again.' });
}
