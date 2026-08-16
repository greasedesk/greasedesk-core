/**
 * File: pages/api/quote-revision-prefill.ts
 * GET ?jobCardId= → everything the revision panel needs: both totals, the difference, whether the
 * customer can be emailed at all, and the prefilled note.
 *
 * Computed FRESH when the panel opens rather than at page load, because the operator may have been
 * editing the estimate in between and the diff must describe what is actually about to be sent.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { formatMoney } from '@/lib/format-money';
import { diffQuoteLines, prefillNote } from '@/lib/quote-diff';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const jobCardId = String(req.query.jobCardId ?? '');
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, vehicle_id: true, customer_id: true,
      site: { select: { currency_code: true, locale: true } },
      items: { orderBy: { created_at: 'asc' }, select: { description: true, qty: true, unit_price: true, vat_amount: true } },
      quoteVersions: { orderBy: { version: 'desc' }, select: { version: true, status: true, gross_pennies: true, lines: { select: { description: true, qty: true, unit_price: true } } } },
    },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'No access to that job card.' });

  const accepted = card.quoteVersions.find((v: any) => v.status === 'accepted');
  if (!accepted) return res.status(200).json({ revision: false });

  const currency = card.site?.currency_code ?? 'GBP';
  const locale = card.site?.locale ?? 'en-GB';
  const money = (p: number) => formatMoney(p, { currency, locale });

  // What the NEXT freeze will capture — the same rows freezeQuoteVersion reads.
  const current = card.items.map((i: any) => ({ description: i.description, qty: Number(i.qty), unitPrice: Number(i.unit_price) }));
  const sendingPennies = card.items.reduce((a: number, i: any) =>
    a + Math.round(Number(i.qty) * Number(i.unit_price) * 100) + Math.round(Number(i.vat_amount) * 100), 0);

  const diff = diffQuoteLines(
    accepted.lines.map((l: any) => ({ description: l.description, qty: Number(l.qty), unitPrice: Number(l.unit_price) })),
    current,
  );

  // CAN WE EMAIL THEM AT ALL? The note is email-only, so the panel must not offer a box that goes
  // nowhere. Resolved through the ownership edge — which quote-send NOW does too. It did not when
  // this comment was first written: it read the card's own customer link, and this claimed
  // otherwise. The two are aligned as of the SMS channel work, and the claim is true again.
  const ownerId = await getCurrentOwnerId(prisma as any, card.vehicle_id).catch(() => null);
  const owner = ownerId
    ? await prisma.customer.findUnique({ where: { id: ownerId }, select: { email: true, name: true, phone_e164: true } })
    : (card.customer_id ? await prisma.customer.findUnique({ where: { id: card.customer_id }, select: { email: true, name: true, phone_e164: true } }) : null);
  const email = (owner?.email ?? '').trim() || null;
  // AND CAN WE TEXT THEM? The panel offers a channel now, so it needs both answers — otherwise
  // picking Text tells the operator about the email address they haven't got.
  const phone = (owner?.phone_e164 ?? '').trim() || null;

  return res.status(200).json({
    revision: true,
    customerName: owner?.name ?? null,
    email,
    phone,
    agreedVersion: accepted.version,
    agreedPennies: accepted.gross_pennies,
    sendingPennies,
    differencePennies: sendingPennies - accepted.gross_pennies,
    diffComplete: diff.complete,
    diffReason: diff.complete ? null : diff.reason,
    prefill: prefillNote({ diff, agreedPennies: accepted.gross_pennies, sendingPennies, money }),
  });
}
