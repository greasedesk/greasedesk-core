/**
 * File: lib/ops-email.ts
 * WHERE GARAGE-FACING OPERATIONAL NOTIFICATIONS GO. One resolver, so every "tell the garage
 * something happened" path lands in the same inbox and a tenant can change it in one place.
 *
 * ── THREE ADDRESSES, THREE JOBS ─────────────────────────────────────────────────────────────────
 *  • ops_email          — this. Where the GARAGE is told things: a customer accepted a quote, an
 *                         email arrived. Nobody outside the garage ever sees it.
 *  • invoice_reply_to   — what a CUSTOMER sees and replies to on an invoice or quote. Outward.
 *  • billing_email      — the account/subscription contact, and an IDENTITY KEY: onboarding upserts
 *                         the group by it and update-rates recovers group_id from it. Editing it to
 *                         fix an email destination would reach much further than intended, which is
 *                         precisely why it is not the place to configure this.
 *
 * Before this existed, quote-respond sent straight to `billing_email` — the address captured from
 * whoever filled in the signup form. On the live tenant that is a personal address, while the
 * garage had configured its real one in the only field Settings offered. The fault was reading a
 * billing-identity field as an operational destination.
 *
 * ── THE FALLBACK IS THE MIGRATION ───────────────────────────────────────────────────────────────
 * NULL ops_email → invoice_reply_to → billing_email. Nothing is backfilled and no tenant's
 * behaviour changes until an owner sets the field: the chain reproduces exactly what each caller
 * did before. `lib/inbound.ts` already hand-rolled `invoice_reply_to || billing_email`; that is now
 * this function, so the two cannot drift.
 *
 * ── NEVER resolveReplyTo ────────────────────────────────────────────────────────────────────────
 * resolveReplyTo answers a different question (what a customer should reply TO) and, when inbound
 * mail is enabled, returns the tenant's inbound address. Forwarding an operational notification
 * there would post it straight back into the inbound pipeline — a loop. Deliberately unrelated.
 */

export type OpsEmailGroup = {
  ops_email?: string | null;
  invoice_reply_to?: string | null;
  billing_email?: string | null;
};

/** Which field answered — for diagnostics and for the Settings hint, never for branching. */
export type OpsEmailSource = 'ops_email' | 'invoice_reply_to' | 'billing_email' | 'none';

export function resolveOpsEmail(group: OpsEmailGroup | null | undefined): { address: string | null; source: OpsEmailSource } {
  const ops = (group?.ops_email ?? '').trim();
  if (ops) return { address: ops, source: 'ops_email' };
  const reply = (group?.invoice_reply_to ?? '').trim();
  if (reply) return { address: reply, source: 'invoice_reply_to' };
  const billing = (group?.billing_email ?? '').trim();
  if (billing) return { address: billing, source: 'billing_email' };
  return { address: null, source: 'none' };
}

/** The columns every caller must select. Keeps a caller from asking for two of the three and
 *  silently skipping a step in the chain. */
export const OPS_EMAIL_SELECT = { ops_email: true, invoice_reply_to: true, billing_email: true } as const;
