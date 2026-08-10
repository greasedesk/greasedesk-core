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

/** Is this tenant a demo? One indexed lookup, and the only place the question is asked. */
export async function isDemoGroup(groupId: string | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  const g = (await prisma.group.findUnique({
    where: { id: groupId }, select: { is_demo: true },
  })) as { is_demo: boolean } | null;
  return !!g?.is_demo;
}

/**
 * ── A DEMO MUST NOT REACH STRIPE ────────────────────────────────────────────────────────────────
 * Checkout on a demo would SUCCEED, and that is worse than failing. The endpoint has no idea the
 * tenant is disposable: it would create a real Checkout session with payment_method_collection
 * 'always', take a real card through real 3DS, and the webhook would write a real subscription —
 * against a group the demo cron hard-deletes days later. Somebody would have subscribed the
 * showroom model, and then watched it be deleted with everything in it.
 *
 * The refusal is 403 with a code the client can branch on, not a 503 "billing isn't configured":
 * billing is configured perfectly well, this tenant simply has nothing to buy. Callers get the same
 * sentence from all three endpoints because they are the same refusal.
 */
export const DEMO_BILLING_REFUSAL = {
  status: 403,
  code: 'demo_tenant' as const,
  message: 'This is a demo garage, so there is nothing to subscribe — nothing in it is real. Start a trial when you want to set up your own.',
};

/**
 * Guard for a billing endpoint. Returns true when it has ALREADY answered the request, so a caller
 * is one line: `if (await refuseDemoBilling(res, groupId)) return;`
 *
 * Placed before any Stripe call and before any write, on purpose — a demo that gets as far as a
 * session id has already had a card typed into it.
 */
export async function refuseDemoBilling(
  res: { status: (c: number) => { json: (b: any) => any } },
  groupId: string | null | undefined,
): Promise<boolean> {
  if (!(await isDemoGroup(groupId))) return false;
  res.status(DEMO_BILLING_REFUSAL.status).json({
    message: DEMO_BILLING_REFUSAL.message, code: DEMO_BILLING_REFUSAL.code,
  });
  return true;
}

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
  if (!(await isDemoGroup(groupId))) return { block: false };

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
