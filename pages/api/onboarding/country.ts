/**
 * File: pages/api/onboarding/country.ts
 * POST { country } — the FIRST onboarding answer. Country drives everything downstream, so choosing
 * it configures the rest of the flow in one write:
 *   • Group.country_code = the choice (also the country-step completion signal)
 *   • Group.tax_country_code / tax_model / tax_label DERIVED from the profile (never free-typed) —
 *     so the invoice label and the tax maths can't drift from the country.
 *   • Any existing Site's currency_code + timezone are set from the profile (the site step, which
 *     runs next, inherits them; if a site doesn't exist yet the site step reads the profile).
 * A SUPPORTED country advances the wizard; an UNSUPPORTED one is stored (so the coming-soon gate can
 * render) but never satisfies onboarding — the tenant sees the waitlist gate.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { requireCanWrite } from '@/lib/admin-guard';
import { getProfile, isSupportedCountry, PICKER_COUNTRIES } from '@/lib/locale-profiles';

const KNOWN = new Set(PICKER_COUNTRIES.map((c) => c.code));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  if (!(await requireCanWrite(user.group_id as string, res))) return;

  const country = String((req.body ?? {}).country ?? '').toUpperCase();
  if (!country || !KNOWN.has(country)) return res.status(400).json({ message: 'Pick a country from the list.' });

  const supported = isSupportedCountry(country);

  // Record the choice either way — an unsupported one is what the coming-soon gate reads.
  await prisma.group.update({ where: { id: user.group_id as string }, data: { country_code: country } });

  if (!supported) {
    return res.status(200).json({ ok: true, supported: false, country });
  }

  // Supported → derive the whole tax + trading identity from the ONE profile.
  const p = getProfile(country);
  await prisma.group.update({
    where: { id: user.group_id as string },
    data: {
      tax_country_code: country,
      tax_model: p.taxModel,
      tax_label: p.taxLabel,
    },
  });
  // Prime any existing site with the country's currency + default timezone (the site step edits them).
  await prisma.site.updateMany({
    where: { group_id: user.group_id as string },
    data: { currency_code: p.currency, timezone: p.defaultTimezone },
  });

  return res.status(200).json({
    ok: true, supported: true, country,
    currency: p.currency, taxModel: p.taxModel, taxLabel: p.taxLabel, defaultTimezone: p.defaultTimezone,
  });
}
