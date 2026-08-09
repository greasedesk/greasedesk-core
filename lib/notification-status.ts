/**
 * File: lib/notification-status.ts
 * THE one-way ratchet: given what a row says now and what a provider has just told us, what should
 * the row say? Pure — no prisma, no HTTP — so the rule can be tested exhaustively without a provider
 * and cannot differ between the webhook, a future sweep and the tests.
 *
 * ── WHY A RATCHET AND NOT AN ASSIGNMENT ─────────────────────────────────────────────────────────
 * Twilio states plainly that callbacks "are not guaranteed to arrive in the order they were sent".
 * A message that is delivered emits `sent` then `delivered`, and if those two arrive the wrong way
 * round a handler that simply writes what it was told walks the row BACKWARDS — from a confirmed
 * delivery to an unconfirmed hand-off. Retries make it worse: a duplicate `sent` an hour later would
 * do the same thing again.
 *
 * So the rule is monotonic. A terminal status is final; nothing replaces it, including another
 * terminal one. Anything non-terminal is ignored outright.
 *
 * ── THEIR `sent` IS NOT OUR `sent` ──────────────────────────────────────────────────────────────
 * Ours means "the provider's API accepted the request". Twilio's means "handed to the carrier".
 * Mapping theirs onto ours would silently redefine a value 131 existing rows already use, so the
 * intermediate statuses are DROPPED rather than translated. We learn nothing from them that the row
 * does not already assert, and pretending otherwise would make our own history mean two things.
 */

/** Our own persisted values (prisma enum NotificationStatus). */
export type NotifyStatus = 'queued' | 'sent' | 'failed' | 'delivered' | 'bounced' | 'skipped' | 'received';

/** What Twilio can put in MessageStatus. Anything unrecognised is treated as intermediate. */
export type ProviderStatus = string;

/**
 * Ours, once reached, never changes. `skipped` is terminal too: we decided not to send, so a
 * provider has nothing to say about it — and a stray callback naming a skipped row is a bug
 * elsewhere, not a status update.
 */
const TERMINAL: ReadonlySet<NotifyStatus> = new Set<NotifyStatus>(['delivered', 'bounced', 'failed', 'skipped', 'received']);
export const isTerminal = (s: NotifyStatus): boolean => TERMINAL.has(s);

/**
 * Twilio → us. Only the endings map; the lifecycle noise does not.
 *   delivered              → delivered   (the first time this product may say the word)
 *   undelivered | failed   → failed      (carrier rejected, or the message could not be placed)
 *   queued|sending|sent|accepted|read|… → null, meaning "no opinion, leave the row alone"
 *
 * `read` is deliberately absent: it exists for channels we do not use, and it is not a delivery.
 */
export function mapProviderStatus(providerStatus: ProviderStatus): NotifyStatus | null {
  switch (String(providerStatus || '').trim().toLowerCase()) {
    case 'delivered': return 'delivered';
    case 'undelivered':
    case 'failed': return 'failed';
    default: return null; // queued, sending, sent, accepted, scheduled, read, anything new
  }
}

export type RatchetDecision =
  | { apply: true; status: NotifyStatus; reason: 'settled' }
  | { apply: false; reason: 'already_terminal' | 'intermediate' | 'unknown_status' };

/**
 * THE DECISION. Returns what to write, or why nothing should be written.
 *
 * Note the order: already-terminal is checked BEFORE the mapping, so a late `sent` arriving after a
 * `delivered` is refused for the honest reason (the row is settled) rather than the incidental one
 * (that `sent` maps to nothing). If the mapping ever grew a case, this order is what keeps the
 * guarantee — and it is the case worth testing, because it is the one that actually happens.
 */
export function ratchet(current: NotifyStatus, providerStatus: ProviderStatus): RatchetDecision {
  if (isTerminal(current)) return { apply: false, reason: 'already_terminal' };
  const next = mapProviderStatus(providerStatus);
  if (!next) {
    // Distinguished for the log only: a status we know and ignore, versus one we have never seen
    // (which is worth noticing if the provider adds one).
    const known = ['queued', 'sending', 'sent', 'accepted', 'scheduled', 'read', 'receiving', 'received']
      .includes(String(providerStatus || '').trim().toLowerCase());
    return { apply: false, reason: known ? 'intermediate' : 'unknown_status' };
  }
  return { apply: true, status: next, reason: 'settled' };
}
