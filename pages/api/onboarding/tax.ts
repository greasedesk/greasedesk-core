/**
 * File: pages/api/onboarding/tax.ts
 * Onboarding tax step (item-13). Writes the tenant's tax profile into EXISTING columns:
 *   vat_registered, vat_number, tax_default_rate_bp (+ default_vat_rate in
 *   lockstep, the legacy Decimal mirror). tax_default_rate_bp going non-NULL is the completion
 *   SIGNAL the root gate reads — this call is what advances the wizard past the tax step.
 * ADMIN-only. Basis points are integer (2000 = 20%); not-registered ⇒ 0 bp, no VAT number.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { requireAdminApi } from '@/lib/admin-guard';

type Body = {
  // NO country field. Country is owned solely by the country step (/api/onboarding/country) — a
  // `tax_country_code` used to be declared here and never read, which read as a write surface that
  // did not exist. Removed 2026-07-30: the type now describes exactly what this route accepts.
  vat_registered?: boolean;
  vat_number?: string;
  vat_rate_percent?: string | number; // percent; converted to integer basis points
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  // ADMIN-ONLY: tax config is owner/admin work.
  if (!(await requireAdminApi(req, res))) return;

  const session = await getServerSession(req, res, authOptions);
  const groupId = (session?.user as any)?.group_id as string | undefined;
  if (!groupId) return res.status(401).json({ message: 'No group in scope.' });

  const { vat_registered, vat_number, vat_rate_percent } = (req.body || {}) as Body;

  const registered = vat_registered !== false; // default registered / charges tax unless explicitly false

  // Rate → integer basis points. Not registered ⇒ 0 bp / no rate charged.
  let rateBp = 0;
  if (registered) {
    const pct = Number(vat_rate_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: 'Enter a VAT rate between 0 and 100.' });
    rateBp = Math.round(pct * 100);
  }
  const vatDec = new Prisma.Decimal((rateBp / 100).toFixed(2)); // lockstep legacy mirror

  const cleanVatNumber = registered && vat_number && vat_number.trim() ? vat_number.trim() : null;

  await prisma.group.update({
    where: { id: groupId },
    data: {
      vat_registered: registered, // country (+ tax_model/tax_label) is owned by the country step — untouched here
      vat_number: cleanVatNumber,
      tax_default_rate_bp: rateBp,   // completion signal (was NULL)
      default_vat_rate: vatDec,      // legacy Decimal mirror, kept in lockstep
    },
  });

  return res.status(200).json({ ok: true });
}
