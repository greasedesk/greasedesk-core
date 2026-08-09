/**
 * File: lib/tenant-rep.ts
 * WHO, IF ANYONE, IS THIS TENANT'S REP — one resolver, so the four conditions that make the answer
 * "somebody" cannot be restated differently by a second reader.
 *
 * ── THE RELATIONSHIP IS AN ATTRIBUTION, WHICH IS NOT QUITE THE SAME THING ───────────────────────
 * There is no "assigned rep" field. The only tenant→rep link is TenantAttribution, and that exists
 * to decide COMMISSION: who gets paid for the signup, created from a `?ref=` parameter. Calling it
 * "your rep" tells a garage they have an account manager when what the data records is an affiliate
 * credit. Usually the same person. Not necessarily, and nothing here can tell the difference — so
 * the copy on the page promises an introducer and a first point of contact, never support.
 *
 * If "my rep" is ever meant to be an ongoing account manager, that is a different field and this
 * resolver should read it instead of being stretched.
 *
 * ── FOUR CONDITIONS, ALL REQUIRED ───────────────────────────────────────────────────────────────
 *   party_type 'rep'   — an OPERATOR attribution (role 'regional') is an internal regional manager
 *                        and not a contact we offer a garage. Empty state.
 *   ended_at  null     — a hand-over ends one attribution as the next begins; an ended one names
 *                        somebody who is no longer anything to this tenant.
 *   rep exists         — party_id is a bare string with no FK, so a deleted rep leaves a dangling
 *                        row. Resolve it or say nothing.
 *   status 'active'    — a suspended rep's contact details are not handed out.
 *
 * ── WHAT IS DELIBERATELY NOT RETURNED ───────────────────────────────────────────────────────────
 * share_bp (what we pay them), payout_details (their bank details) and ref_code (their attribution
 * token — a garage that saw it could pass it around and misattribute other signups). None of the
 * three is shaped for a tenant's eyes, and the safest way to keep them out of a page is to keep
 * them out of the object the page receives.
 */
import { prisma } from '@/lib/db';

/** Everything a garage may see about their rep. Two fields, because Rep holds nothing else public. */
export type TenantRep = { name: string; email: string };

/**
 * NULL means "no rep", which is the ordinary case rather than a fault: most garages sign up
 * directly. The page says so plainly instead of rendering an empty card.
 *
 * NOTE on `email`: it is the rep's LOGIN email, which is the only address Rep carries. Acceptable
 * while there are no live reps (there are none today) — but Rep needs a separate public contact
 * field before a real person's credentials double as their published contact address.
 */
export async function tenantRep(groupId: string | null | undefined): Promise<TenantRep | null> {
  if (!groupId) return null;
  const attribution = await prisma.tenantAttribution.findFirst({
    where: { group_id: groupId, party_type: 'rep', ended_at: null },
    orderBy: { effective_from: 'desc' }, // a tenant should have one live attribution; newest wins if not
    select: { party_id: true },
  });
  if (!attribution) return null;

  const rep = await prisma.rep.findUnique({
    where: { id: attribution.party_id },
    select: { name: true, email: true, status: true },
  });
  if (!rep || rep.status !== 'active') return null;
  return { name: rep.name, email: rep.email };
}
