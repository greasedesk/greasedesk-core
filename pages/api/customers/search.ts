/**
 * File: pages/api/customers/search.ts
 *
 * FIND A CUSTOMER ALREADY ON THE BOOKS — built for picking the buyer of a car, because nothing in the
 * app could do it: /api/jobcard resolves an owner from the vehicle's own record, which for a stock
 * car is the garage's situation and not the buyer's.
 *
 * Why picking matters: a car sold to somebody already on the books must link to THEM, so the service
 * history stays with the person. A second "J Smith" created by typing the name again splits it.
 *
 * Tenant-scoped through requireTenantApi. Returns at most ten, and only after two characters — a
 * one-letter search over a whole customer list is a listing, not a search.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed.' });

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) return res.status(200).json({ customers: [] });

  const digits = q.replace(/\D/g, '');
  const customers = await prisma.customer.findMany({
    where: {
      group_id: scope.groupId,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        // A phone typed with or without spaces still finds the number held with them.
        ...(digits.length >= 4 ? [{ phone_e164: { contains: digits } }, { phone: { contains: q } }] : []),
      ],
    },
    select: { id: true, name: true, address: true, phone: true, email: true },
    orderBy: { name: 'asc' },
    take: 10,
  });
  return res.status(200).json({ customers });
}
