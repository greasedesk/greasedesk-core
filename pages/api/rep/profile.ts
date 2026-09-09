/**
 * File: pages/api/rep/profile.ts
 * A REP EDITS THEIR OWN PROFILE — and two things on it are not theirs to touch.
 *
 * ── WHAT IS DELIBERATELY ABSENT FROM THIS FILE ──────────────────────────────────────────────────
 * `email` and the three bank columns. Both are operator-only, in the Engine Room, and both changes
 * are written to SuperAdminAudit with target_rep_id.
 *
 * EMAIL, because with passwords retracted the address IS the credential: a rep who can change it
 * can hand their account to anybody, and every "who could have signed in?" answer becomes a guess.
 * BANK DETAILS, because they are where our money goes. A compromised rep session that can redirect
 * payment is a compromised session that costs real money, and the whole point of the 24-hour
 * window is that such a session is short — not that it is harmless.
 *
 * The guard is the WRITE SHAPE, not a filter: the update names its columns explicitly, so a field
 * that is not listed cannot arrive by being posted. rep-invoice-gate asserts no rep route mentions
 * either, which is a ban on the file rather than on a reviewer's attention.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireRepApi } from '@/lib/rep-auth';

const clean = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;   // BLANK CLEARS, never stores an empty string — Rep_profile_blank_chk
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const rep = await requireRepApi(req, res);
  if (!rep) return;

  const b = req.body ?? {};
  // VAT IS THREE-STATE ON THE WAY IN TOO. An absent field leaves the column untouched; only an
  // explicit true/false answers it. Coercing undefined to false would silently answer "not
  // registered" on behalf of a rep who never saw the question.
  const vatRegistered = b.vat_registered === true ? true : b.vat_registered === false ? false : undefined;
  const registered = vatRegistered === true;

  try {
    await prisma.rep.update({
      where: { id: rep.repId },
      data: {
        trading_name: clean(b.trading_name),
        address_line1: clean(b.address_line1),
        address_line2: clean(b.address_line2),
        address_locality: clean(b.address_locality),
        address_region: clean(b.address_region),
        address_postcode: clean(b.address_postcode),
        contact_email: clean(b.contact_email),
        utr: clean(b.utr),
        ...(vatRegistered === undefined ? {} : {
          vat_registered: vatRegistered,
          // THE THREE MOVE AS ONE. Rep_vat_chk refuses any other combination, so answering "no"
          // must clear the number and the date rather than leave a stale pair behind.
          vat_number: registered ? clean(b.vat_number) : null,
          vat_effective_from: registered && b.vat_effective_from ? new Date(String(b.vat_effective_from)) : null,
        }),
      },
    });
    return res.status(204).end();
  } catch (e) {
    // A CHECK CONSTRAINT REFUSING IS A SENTENCE THE REP CAN ACT ON, not a 500. The commonest is
    // saying "registered" without a number or a date.
    if (/Rep_vat_chk/.test(String((e as Error).message))) {
      return res.status(400).json({ message: 'If you are VAT registered, give both your VAT number and the date registration took effect.' });
    }
    throw e;
  }
}
