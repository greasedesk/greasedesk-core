/**
 * File: lib/reply-to.ts
 * THE reply-to resolver. One function, called by every outbound customer message, so "where does a
 * reply go?" has exactly one answer and exactly one place to change it.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A FIELD READ ─────────────────────────────────────────────────
 * Today a reply goes to the GARAGE'S OWN MAILBOX: the product cannot receive email, so the honest
 * destination is a human who can. The moment an inbound path exists, replies must instead go to a
 * per-tenant inbound address that the product parses and files onto the thread — and that has to be
 * ONE edit, here, not a hunt through every send site. `invoice_reply_to` was already being read
 * inline in the invoice path; that literal is now this call.
 *
 * The fallbacks are ordered by how likely they are to be READ BY A PERSON, which is the whole point
 * of a reply-to: the tenant's configured reply address, then their billing address, then nothing.
 * Returning undefined is correct and deliberate — no Reply-To header at all is better than one
 * pointing at a no-reply mailbox nobody watches.
 */
import { threadAddress, tenantAddress } from '@/lib/inbound-address';

export type ReplyToGroup = {
  invoice_reply_to?: string | null;
  billing_email?: string | null;
  /** The tenant's inbound mailbox token. Absent = no inbound address exists yet. */
  inbound_token?: string | null;
};

export type ReplyToOpts = {
  /** ONLY tenants with the inbound entitlement get an inbound reply-to. Without it, replies must
   *  keep going to the mailbox their staff already watch — flipping that for a tenant who cannot
   *  see the inbox would silently swallow their customer replies. */
  inboundEnabled?: boolean;
  /** When the message belongs to a conversation, the reply comes back to THAT conversation. */
  threadToken?: string | null;
};

/**
 * INBOUND FIRST, when and only when the tenant is entitled and a token exists. Otherwise the
 * previous behaviour, unchanged: the tenant's configured reply address, then billing, then nothing.
 */
export function resolveReplyTo(group: ReplyToGroup | null | undefined, opts: ReplyToOpts = {}): string | undefined {
  if (opts.inboundEnabled && group?.inbound_token) {
    return opts.threadToken
      ? threadAddress(group.inbound_token, opts.threadToken)
      : tenantAddress(group.inbound_token);
  }
  const configured = (group?.invoice_reply_to ?? '').trim();
  if (configured) return configured;
  const billing = (group?.billing_email ?? '').trim();
  if (billing) return billing;
  return undefined;
}
