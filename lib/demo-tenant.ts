/**
 * File: lib/demo-tenant.ts
 * THE demo-tenant chokepoint. A demo holds hundreds of invented customers with names, addresses,
 * phone numbers and email addresses, and it is fully read/write — so the one thing that must be
 * impossible is a message reaching a real person from it.
 *
 * ── WHY RESERVED RANGES ARE NOT ENOUGH ──────────────────────────────────────────────────────────
 * The generator writes every contact inside Ofcom's 07700 900xxx drama range and RFC 2606's
 * example.com, both of which are unroutable by construction. That protects GENERATED data and
 * nothing else. The first thing a garage owner does in a demo is add a customer and type their own
 * mobile in, and no reserved range helps there. The only structural guarantee is a refusal at the
 * send, keyed on the TENANT rather than on the address.
 *
 * ── WHERE THE CHECK HAS TO SIT ──────────────────────────────────────────────────────────────────
 * BEFORE lib/notify's `!tpl.security` branch, not inside isSuppressed. Security templates
 * (phone_verify, password reset) deliberately bypass contact preferences — a demo check placed
 * inside the suppression path would let exactly those out. Proved on the deployed code before this
 * existed: a demo tenant's phone_verify reached Twilio and came back with error 21211.
 *
 * ── ONE EXCEPTION, KEYED ON THE RECIPIENT ───────────────────────────────────────────────────────
 * The person who started the demo has to be able to get back into it, and to be told it is about to
 * end. So their OWN address is allowed — matched by recipient, not by a template allow-list, so a
 * template classified wrongly still cannot reach a customer record.
 *
 * Deliberately narrow: the OWNER only, not every staff user. A demo owner who invites a colleague
 * will find the invitation blocked. That is the safe direction to be wrong in, and widening it
 * later is one line; the reverse is a leak.
 */
import { prisma } from '@/lib/db';

/** Ofcom's reserved drama range — allocated to no carrier, routes nowhere. */
export const isReservedPhone = (v: string | null | undefined): boolean => {
  const d = String(v ?? '').replace(/\D/g, '');
  return /^(44|0)?7700900\d{3}$/.test(d);
};

/** RFC 2606 reserved domains — no MX, deliverable to nobody. */
export const isReservedEmail = (v: string | null | undefined): boolean =>
  /@(example\.(com|net|org)|.*\.invalid)$/i.test(String(v ?? '').trim());

export type DemoSendDecision =
  | { block: false }
  | { block: true; reason: string };

/**
 * Should this send be refused because it belongs to a demo tenant?
 *
 * Costs ONE indexed lookup on a send that has a groupId, and short-circuits to `block:false` for
 * every real tenant before doing anything else. The owner lookup only runs for demos.
 */
export async function demoSendDecision(
  groupId: string | null | undefined,
  recipient: string,
): Promise<DemoSendDecision> {
  if (!groupId) return { block: false }; // platform-level send — no tenant to be a demo
  const g = (await prisma.group.findUnique({
    where: { id: groupId }, select: { is_demo: true },
  })) as { is_demo: boolean } | null;
  if (!g?.is_demo) return { block: false };

  const owner = (await prisma.user.findFirst({
    where: { group_id: groupId, is_owner: true }, select: { email: true },
  })) as { email: string } | null;
  const to = recipient.trim().toLowerCase();
  if (owner && owner.email.trim().toLowerCase() === to) return { block: false };

  return {
    block: true,
    // Named so the row is self-explaining months later, and so a surface can tell this apart from
    // an opt-out or an unconfigured provider — three different sentences for a garage.
    reason: 'demo tenant — messages are never sent from a demo',
  };
}
