/**
 * File: lib/marketing-suppression.ts
 * MAY GREASEDESK SEND THIS SEQUENCE'S MAIL TO THIS ADDRESS? Asked by sendNotification itself, before
 * every platform marketing send — never by a caller, so no caller can skip it.
 *
 * Replaces lib/prospect-suppression, which asked the same question with one audience assumed. The
 * list, the hash and the fail-closed rule are carried over unchanged; what is new is that the
 * question now names WHICH SEQUENCE is asking, because the answer differs between them. The
 * reasoning for that lives beside the data, in lib/marketing-engine::REFUSE_IF_CUSTOMER.
 *
 * ── THE DEFECT THIS DOES NOT INHERIT ────────────────────────────────────────────────────────────
 * lib/notify::isSuppressed begins `if (!groupId) return false` — "no tenant customer list to
 * consult". Every PLATFORM send is therefore unsuppressible: opt-out lives on a tenant's Customer
 * rows and GreaseDesk-as-sender has none. All four of these sequences are platform sends, so without
 * this module not one of them would honour an unsubscribe.
 *
 * ── ONE UNSUBSCRIBE STOPS ALL FOUR (owner, 2026-11-02) ──────────────────────────────────────────
 * ProspectSuppression is keyed on the hash of the address and nothing else, and it is reused here
 * exactly as it is. An unsubscribe is a statement about the sender, not about a campaign, so one
 * click ends every sequence for that address — and a per-sequence list would be four chances to get
 * it wrong instead of one. Their invoices, receipts and sign-in codes are unaffected: those are not
 * marked marketing, which is why the flag lives on the template.
 *
 * ── FAILS CLOSED ────────────────────────────────────────────────────────────────────────────────
 * isSuppressed fails OPEN, and it is right to: a lookup error must not drop a customer's MOT
 * reminder. Marketing mail is the opposite case — nobody is owed it, and the cost of a wrong send is
 * a customer or an unsubscribed person being marketed to. An error here REFUSES.
 */
import { prisma } from '@/lib/db';
import { normaliseEmail } from '@/lib/prospects';
import { emailHash } from '@/lib/prospect-keys';
import { REFUSE_IF_CUSTOMER, type SequenceKey } from '@/lib/marketing-engine';

/**
 * `already_customer` keeps the code the skip already had. The other two are deliberately NOT called
 * `marketing_unsubscribed` / `marketing_check_failed`: lib/notify already has a
 * `marketing_check_failed`, meaning a TENANT'S customer said "no reminders or offers" and the
 * preference could not be read. Two meanings behind one code makes every count of either one a lie
 * (shared-identifier-hides-subject), so the platform's own refusals say `platform_`.
 */
export type MarketingRefusal = 'already_customer' | 'platform_unsubscribed' | 'platform_check_failed';

export async function marketingRefusal(recipient: string, sequence: SequenceKey): Promise<MarketingRefusal | null> {
  const to = normaliseEmail(recipient);
  if (!to) return 'platform_check_failed';
  try {
    // ASKED IN ONE ROUND TRIP, and the customer half is not asked at all for the three sequences
    // whose audience IS our customers and partners — a query whose answer is ignored is a query that
    // will one day be read by mistake.
    const wantsCustomerCheck = REFUSE_IF_CUSTOMER[sequence] === true;
    const [user, tenant, suppressed] = await Promise.all([
      wantsCustomerCheck
        ? prisma.user.findFirst({ where: { email: { equals: to, mode: 'insensitive' } }, select: { id: true } })
        : null,
      wantsCustomerCheck
        ? prisma.group.findFirst({ where: { billing_email: { equals: to, mode: 'insensitive' } }, select: { id: true } })
        : null,
      prisma.prospectSuppression.findUnique({ where: { email_hash: emailHash(to) }, select: { id: true } }),
    ]);
    // THE WORSE OUTCOME FIRST, as the module it replaces had it: a paying customer receiving
    // prospecting mail is the worst thing this feature can produce, and it is refused here whether or
    // not signup matching ran and whether or not a sequence remembered to stop.
    if (user || tenant) return 'already_customer';
    if (suppressed) return 'platform_unsubscribed';
    return null;
  } catch {
    return 'platform_check_failed';
  }
}
