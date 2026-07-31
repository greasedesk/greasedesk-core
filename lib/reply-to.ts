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
export type ReplyToGroup = {
  invoice_reply_to?: string | null;
  billing_email?: string | null;
};

export function resolveReplyTo(group: ReplyToGroup | null | undefined): string | undefined {
  // WHEN INBOUND LANDS: return the tenant's inbound address here (e.g. `t-${group.ref}@in.greasedesk.com`)
  // and every outbound message starts threading its replies. One line, one file.
  const configured = (group?.invoice_reply_to ?? '').trim();
  if (configured) return configured;
  const billing = (group?.billing_email ?? '').trim();
  if (billing) return billing;
  return undefined;
}
