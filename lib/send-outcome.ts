/**
 * File: lib/send-outcome.ts
 * WHY A MESSAGE DID NOT GO, in the operator's words. One mapping, every sender.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────────
 * sendNotification already returns a discriminated `skipCode` for every way a send can fail:
 * demo_tenant, opted_out, not_configured, no_recipient, no_renderer, unknown_template,
 * allowance_spent — plus a provider failure carrying the provider's own reason. The information was
 * never missing. Each caller then collapsed it: quote-send handled two codes and swept the rest into
 * "The text couldn't be sent", and invoice-sms said "please try again shortly" for conditions that
 * retrying can never fix. A demo tenant will refuse the next attempt exactly as it refused this one.
 *
 * On 2026-08-18 that cost a real diagnosis. Two sends failed with `demo tenant — messages are never
 * sent from a demo`; the screen said the text couldn't be sent; the cause was read as the provider.
 * Twilio had never been contacted. THE MESSAGE NAMED A CAUSE IT HAD NOT ESTABLISHED — the same shape
 * as a banner asserting a reason it never checked.
 *
 * ── THE THREE SILENCES ARE DIFFERENT ACTIONS ────────────────────────────────────────────────────
 * They are not three phrasings of one event. They tell the operator to do three different things:
 *   NO ADDRESS ON FILE     → get a number from the customer. Nothing to retry.
 *   BLOCKED BY POLICY      → nothing is wrong; this tenant/customer does not receive sends.
 *   PROVIDER REJECTED IT   → the number reached the provider and was refused. Retrying may work.
 * A sentence that fits all three is a sentence that helps in none.
 *
 * `retryable` is returned alongside the words so a caller never has to re-derive it from prose, and
 * so an HTTP status can follow the fact rather than a guess.
 */

/** The shape lib/notify::sendNotification returns on failure. Structural, so no import cycle. */
export type FailedSend = {
  ok: false;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string | null;
  suppressed?: boolean;
  skipCode?:
    | 'demo_tenant' | 'opted_out' | 'not_configured' | 'no_recipient'
    | 'no_renderer' | 'unknown_template' | 'allowance_spent';
};

export type SendFailureCopy = {
  /** One sentence, operator-facing. No trailing "but the link still works" — that is the caller's. */
  message: string;
  /** Would attempting the same send again plausibly succeed? */
  retryable: boolean;
  /** Stable identifier for the case, so a test names the branch rather than matching prose. */
  code: string;
};

const noun = (channel: string) => (channel === 'sms' ? 'text' : 'email');
const plural = (channel: string) => (channel === 'sms' ? 'text messages' : 'emails');
const address = (channel: string) => (channel === 'sms' ? 'mobile number' : 'email address');

export function describeSendFailure(
  sent: FailedSend,
  ctx: { channel: string; customerName?: string | null },
): SendFailureCopy {
  const who = ctx.customerName?.trim() || 'This customer';

  switch (sent.skipCode) {
    case 'no_recipient':
      return { code: 'no_recipient', retryable: false,
        message: `No ${address(ctx.channel)} on file for ${who}.` };

    case 'demo_tenant':
      // NAMED, not disguised. A rep demonstrating on a demo tenant needs to know the message was
      // withheld deliberately rather than lost — the alternative is a demo that appears broken.
      return { code: 'demo_tenant', retryable: false,
        message: `This is a demo tenant, so no ${plural(ctx.channel)} are actually sent.` };

    case 'opted_out':
      return { code: 'opted_out', retryable: false,
        message: `${who} has opted out of ${plural(ctx.channel)}.` };

    case 'not_configured':
      return { code: 'not_configured', retryable: false,
        message: `${ctx.channel === 'sms' ? 'Text messaging' : 'Email'} is not set up for this garage yet.` };

    case 'allowance_spent':
      return { code: 'allowance_spent', retryable: false,
        message: `Your ${ctx.channel === 'sms' ? 'SMS' : 'email'} allowance ran out as this was sending.` };

    case 'no_renderer':
    case 'unknown_template':
      // A PROGRAMMING FAULT, said plainly rather than dressed as a delivery problem. Telling an
      // operator to retry a message that has no renderer wastes their time on our defect.
      return { code: 'not_sendable', retryable: false,
        message: `This message cannot be sent by ${noun(ctx.channel)} — please report it.` };

    default:
      break;
  }

  // NO skipCode AND status 'failed' — the provider was actually contacted and refused. This is the
  // ONLY branch entitled to say the provider rejected it, and the only retryable one.
  if (sent.status === 'failed') {
    const why = (sent.reason ?? '').trim();
    return { code: 'provider_rejected', retryable: true,
      message: why
        ? `The provider rejected the ${noun(ctx.channel)}: ${why}`
        : `The provider rejected the ${noun(ctx.channel)}.` };
  }

  // Skipped with no code. Should not occur; says so rather than inventing a cause.
  return { code: 'unknown', retryable: false,
    message: `The ${noun(ctx.channel)} was not sent${(sent.reason ?? '').trim() ? `: ${sent.reason}` : ' and no reason was recorded.'}` };
}
