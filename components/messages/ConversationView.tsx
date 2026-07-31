/**
 * File: components/messages/ConversationView.tsx
 * READ-ONLY conversation render for one (customer, vehicle) thread. No compose, no reply, no
 * mark-as-read in this slice — the product cannot receive a message yet, so anything that implied
 * two-way traffic would be a lie in the interface.
 *
 * ── WHAT "SENT" MEANS HERE, AND WHAT IT DOES NOT ────────────────────────────────────────────────
 * `sent` means THE PROVIDER ACCEPTED IT. It does not mean delivered, and this component must never
 * say delivered. Nothing in the product writes a delivery status: there is no provider webhook, and
 * NotificationLog.provider_message_id is null on every row, so there is nothing to reconcile a
 * delivery against. The label says "accepted by provider" for exactly that reason.
 *
 * DIRECTION is always outbound — there is no inbound path anywhere in the product. It is rendered
 * so the column exists honestly for the day inbound lands, not because there is variety today.
 */
import React from 'react';

export type ConversationMessage = {
  id: string;
  at: string;
  channel: string;
  direction: 'out';
  template: string;
  status: string;
  recipient: string;
  subject: string | null;
  error: string | null;
};

/** Message-type labels. A template key is an internal name and is never shown raw. */
const TEMPLATE_LABEL: Record<string, string> = {
  quote_ready: 'Quote sent',
  quote_accepted: 'Quote accepted (garage alert)',
  quote_declined: 'Quote declined (garage alert)',
  job_card_link: 'Job progress link',
  invoice_document: 'Invoice / receipt',
  team_invite: 'Team invitation',
  password_reset: 'Password reset',
  signup_verify: 'Email verification',
};

/**
 * Status wording, chosen so nothing overstates what the system knows. There is deliberately no
 * "Delivered" — see the file header.
 */
function statusChip(status: string): { text: string; cls: string; title: string } {
  switch (status) {
    case 'sent':
      return { text: 'Accepted by provider', cls: 'bg-ok-soft text-ok border-ok', title: 'The email provider accepted this message. That is not proof it arrived — the product records no delivery status.' };
    case 'skipped':
      return { text: 'Not sent', cls: 'bg-warn-soft text-warn border-warn', title: 'The system deliberately did not send this. The reason is shown beside it.' };
    case 'failed':
      return { text: 'Failed', cls: 'bg-danger-soft text-danger border-danger', title: 'The provider rejected the message, or the send threw.' };
    case 'queued':
      return { text: 'Queued', cls: 'bg-surface-muted text-muted border-line', title: 'Recorded but not yet handed to a provider.' };
    default:
      return { text: status, cls: 'bg-surface-muted text-muted border-line', title: status };
  }
}

const fmt = (iso: string, locale = 'en-GB') => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
};

export default function ConversationView({ messages, locale = 'en-GB', heading = 'Messages', dense = false }: {
  messages: ConversationMessage[];
  locale?: string;
  heading?: string | null;
  dense?: boolean;
}) {
  return (
    <section data-testid="conversation" className={dense ? '' : 'mt-6'}>
      {heading && (
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-ink">{heading}</h3>
          <span className="text-xs text-muted" data-testid="conversation-count">
            {messages.length === 1 ? '1 message' : `${messages.length} messages`}
          </span>
        </div>
      )}

      {messages.length === 0 ? (
        // An EMPTY conversation is a normal state, not an error and not a missing thing. A car
        // nobody has messaged about should read as exactly that.
        <p className="text-sm text-muted border border-dashed border-line rounded-xl p-4" data-testid="conversation-empty">
          No messages have been sent to this customer about this vehicle yet.
        </p>
      ) : (
        <ol className="space-y-2" data-testid="conversation-list">
          {messages.map((m) => {
            const chip = statusChip(m.status);
            return (
              <li key={m.id} data-testid="conversation-item" data-status={m.status} className="border border-line rounded-xl p-3 bg-surface">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-ink">{TEMPLATE_LABEL[m.template] ?? m.template}</span>
                  <span className="uppercase tracking-wide text-muted border border-line rounded px-1.5 py-0.5">{m.channel}</span>
                  {/* Outbound is the only direction the product has. Stated, not implied. */}
                  <span className="text-muted" title="Sent by the garage. The product has no inbound message path yet.">↗ Outbound</span>
                  <span className={`rounded-full border px-2 py-0.5 ${chip.cls}`} title={chip.title} data-testid={`status-${m.status}`}>{chip.text}</span>
                  <span className="ml-auto text-muted tabular-nums" data-testid="conversation-time">{fmt(m.at, locale)}</span>
                </div>
                <div className="mt-1 text-xs text-muted break-all">
                  To {m.recipient}{m.subject ? <> · <span className="text-ink">{m.subject}</span></> : null}
                </div>
                {m.error && <div className="mt-1 text-xs text-warn">{m.error}</div>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
