/**
 * File: lib/prospect-suppression.ts
 * MAY GREASEDESK SEND PROSPECTING MAIL TO THIS ADDRESS? Asked by sendNotification itself, before
 * every prospecting send — never by a caller, so no caller can skip it.
 *
 * ── THE DEFECT THIS DOES NOT INHERIT ────────────────────────────────────────────────────────────
 * lib/notify::isSuppressed begins `if (!groupId) return false` — "no tenant customer list to
 * consult". Every PLATFORM send is therefore unsuppressible: opt-out lives on a tenant's Customer
 * rows and GreaseDesk-as-sender has none. A prospect's unsubscribe, routed through that check, would
 * have been ignored. This is a different list, asked for a different kind of mail.
 *
 * ── TWO REFUSALS, AND THE WORSE ONE FIRST IN ANY READING ────────────────────────────────────────
 *   already_customer — the address belongs to a GreaseDesk USER or a tenant's billing address. The
 *     worst outcome this whole feature can produce is a paying customer receiving prospecting mail,
 *     so it is refused HERE, at the send, whether or not signup matching ran, whether or not a
 *     sequence remembered to stop. It does not depend on any other clause being right.
 *   prospect_unsubscribed — the address's hash is in ProspectSuppression. Survives the address
 *     itself being stripped, so a rep typing it back in months later cannot restart anything.
 *
 * ── FAILS CLOSED ────────────────────────────────────────────────────────────────────────────────
 * isSuppressed fails OPEN, and it is right to: a lookup error must not drop a customer's MOT
 * reminder. Prospecting mail is the opposite case — nobody is owed it, and the cost of a wrong send
 * is a customer or an unsubscribed person being marketed to. An error here REFUSES.
 */
import { prisma } from '@/lib/db';
import { normaliseEmail } from '@/lib/prospects';
import { emailHash } from '@/lib/prospect-keys';

export type ProspectingRefusal = 'already_customer' | 'prospect_unsubscribed' | 'prospect_check_failed';

export async function prospectingRefusal(recipient: string): Promise<ProspectingRefusal | null> {
  const to = normaliseEmail(recipient);
  if (!to) return 'prospect_check_failed';
  try {
    const [user, tenant, suppressed] = await Promise.all([
      prisma.user.findFirst({ where: { email: { equals: to, mode: 'insensitive' } }, select: { id: true } }),
      prisma.group.findFirst({ where: { billing_email: { equals: to, mode: 'insensitive' } }, select: { id: true } }),
      prisma.prospectSuppression.findUnique({ where: { email_hash: emailHash(to) }, select: { id: true } }),
    ]);
    if (user || tenant) return 'already_customer';
    if (suppressed) return 'prospect_unsubscribed';
    return null;
  } catch {
    return 'prospect_check_failed';
  }
}
