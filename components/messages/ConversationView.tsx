/**
 * File: components/messages/ConversationView.tsx
 * The conversation for one (customer, vehicle) thread, plus the staff compose box. ONE component,
 * used on the job card and on the Messages screen, so the two surfaces cannot drift.
 *
 * NO OPTIMISTIC APPEND. After a send the server returns the thread AS THE LOG HAS IT and the list
 * re-renders from that. There is deliberately no local "sending…" item: a refused send must appear
 * as refused, and an interface that shows a message the log doesn't have is lying about the record.
 * Still no mark-as-read and no reply — the product cannot receive a message yet.
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
import React, { useState } from 'react';

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
  body?: string | null;
  /** Null = the SYSTEM sent it (quote, receipt, cron). Set = a person did, and who. */
  sentByName?: string | null;
};

/** Whether this conversation can be written to, and if not, why not — resolved server-side. */
export type Reachability =
  | { ok: true; address: string; customerName: string; channel: string }
  | { ok: false; reason: string; customerName: string; channel: string };

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
  free_text: 'Message',
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

export default function ConversationView({
  messages, locale = 'en-GB', heading = 'Messages', dense = false,
  threadId, jobCardId, reachability, canSend = false, onSent,
}: {
  messages: ConversationMessage[];
  locale?: string;
  heading?: string | null;
  dense?: boolean;
  /** The conversation, when it already exists. */
  threadId?: string | null;
  /** The card to write ABOUT when no thread exists yet — the send creates the thread. Either this
   *  or threadId opens the box; without both there is nothing to write to. */
  jobCardId?: string | null;
  /** Server-resolved. Absent or !ok closes the box with a reason. */
  reachability?: Reachability | null;
  canSend?: boolean;
  /** Called with the thread AS THE SERVER RETURNED IT, so the parent re-renders from the log. */
  onSent?: (messages: ConversationMessage[]) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  async function send() {
    if ((!threadId && !jobCardId) || !text.trim()) return;
    setBusy(true); setNote(null);
    try {
      const r = await fetch('/api/messages/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // CHANNEL IS A FIELD. No selector yet — there is nothing to select while SMS is unconfigured.
        body: JSON.stringify(threadId ? { threadId, body: text, channel: 'email' } : { jobCardId, body: text, channel: 'email' }),
      });
      const d = await r.json().catch(() => ({}));
      // The server returns the thread on refusal too, so the refusal is VISIBLE in the list rather
      // than only in a toast that disappears.
      if (Array.isArray(d?.messages)) onSent?.(d.messages);
      if (r.ok) { setText(''); setNote({ text: 'Sent.', ok: true }); }
      else setNote({ text: d?.message || 'The message was not sent.', ok: false });
    } catch {
      setNote({ text: 'Could not reach the server — nothing was sent.', ok: false });
    } finally {
      // Cleared in finally: a same-URL refresh never remounts this, so unmount can't be relied on.
      setBusy(false);
    }
  }

  const target = threadId || jobCardId || null;
  const closed = !target || !canSend || !reachability || reachability.ok !== true;

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
                  {' · '}
                  {/* WHO sent it. Null is the system, and it says so — it does not borrow a name. */}
                  <span data-testid="sent-by">{m.sentByName ? `Sent by ${m.sentByName}` : 'Sent automatically'}</span>
                </div>
                {m.body && (
                  <p className="mt-2 text-sm text-ink whitespace-pre-wrap border-l-2 border-line pl-3" data-testid="message-body">{m.body}</p>
                )}
                {m.error && <div className="mt-1 text-xs text-warn">{m.error}</div>}
              </li>
            );
          })}
        </ol>
      )}

      {/* ── COMPOSE ─────────────────────────────────────────────────────────────────────────────
          Closed BEFORE anyone types when the customer cannot be reached. Accepting the words and
          failing afterwards wastes them and teaches staff not to trust the box. */}
      {canSend && target && (
        <div className="mt-4" data-testid="compose">
          {closed ? (
            <div className="text-sm text-muted border border-dashed border-line rounded-xl p-4" data-testid="compose-closed">
              {reachability && reachability.ok === false
                ? reachability.reason
                : 'This conversation cannot be written to.'}
            </div>
          ) : (
            <>
              <label className="block text-xs uppercase text-muted mb-1" htmlFor="compose-body">Send a message</label>
              <textarea
                id="compose-body" data-testid="compose-body" rows={3} value={text} disabled={busy}
                onChange={(e) => setText(e.target.value)} maxLength={2000}
                placeholder={`Write to ${reachability.customerName}…`}
                className="w-full p-2.5 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent"
              />
              <div className="flex items-center gap-3 mt-1.5">
                <button
                  type="button" onClick={send} disabled={busy || !text.trim()} data-testid="compose-send"
                  className="rounded-lg px-4 py-2 text-sm font-semibold text-white bg-accent disabled:opacity-50"
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
                <span className="text-xs text-muted">
                  Goes to {reachability.address} by {reachability.channel}. Replies come back to the garage.
                </span>
                {note && <span className={`text-xs ml-auto ${note.ok ? 'text-ok' : 'text-warn'}`} data-testid="compose-note">{note.text}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
