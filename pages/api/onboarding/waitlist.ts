/**
 * File: pages/api/onboarding/waitlist.ts
 * POST { email } — the coming-soon capture. A visitor whose country GreaseDesk isn't live in yet
 * leaves their email; we store it WITH their chosen country so demand-by-country is queryable.
 * The country is read from Group.country_code (already written by the country step), never trusted
 * from the client.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const email = String((req.body ?? {}).email ?? '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ message: 'Enter a valid email address.' });
  }

  const grp = (await prisma.group.findUnique({
    where: { id: user.group_id as string }, select: { country_code: true },
  })) as { country_code: string | null } | null;

  await prisma.countryWaitlist.create({
    data: { email, country_code: grp?.country_code || 'XX', group_id: user.group_id as string },
  });

  return res.status(200).json({ ok: true });
}
