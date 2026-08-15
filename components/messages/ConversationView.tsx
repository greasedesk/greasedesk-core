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
 * ── WHAT EACH STATUS MEANS, AND WHAT IT DOES NOT ────────────────────────────────────────────────
 * `sent` means THE PROVIDER ACCEPTED IT — nothing more. It is not proof of arrival and this
 * component must never render it as one.
 *
 * `delivered` is new (2026-08-09) and is the ONLY value entitled to that word. It is written solely
 * by the Twilio status callback (pages/api/webhooks/twilio-status), never by a send. SMS only: there
 * is no equivalent for email, so an email row can still only reach `sent` and must keep saying
 * "accepted by provider".
 *
 * BOTH OF THE OLD CAVEATS HERE WERE STALE and are corrected rather than deleted, because the
 * reasoning still matters: this once said provider_message_id was null on every row (SMS rows now
 * carry Twilio's SID, which is what makes reconciliation possible at all), and that there was no
 * inbound path anywhere in the product (the inbound-email slice added one — hence `received`).
 */
import React, { useState } from 'react';

export type ConversationMessage = {
  id: string;
  at: string;
  channel: string;
  direction: 'out' | 'in';
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

/** The shape lib/sms-allowance returns, with the reset date as the string it crosses JSON as. */
export type SmsAllowance = {
  included: number; usedThisMonth: number; includedRemaining: number;
  topUpRemaining: number; remaining: number; purchased: number; resetsAt: string;
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
  free_text: 'Message',
  inbound_email: 'Customer reply',
  inbound_forward: 'Copy to the garage',
};

/**
 * Status wording, chosen so nothing overstates what the system knows. There is deliberately no
 * "Delivered" — see the file header.
 */
function statusChip(status: string): { text: string; cls: string; title: string } {
  switch (status) {
    case 'delivered':
      // THE ONE STATUS THAT MAY SAY IT. Written only by the provider's status callback, and only
      // after the carrier confirmed the handset took it.
      return { text: 'Delivered', cls: 'bg-ok-soft text-ok border-ok', title: 'The network confirmed this message reached the handset.' };
    case 'sent':
      // Deliberately NOT "sent" on the chip. The word invites the reader to assume arrival, which is
      // the assumption this label exists to prevent.
      return { text: 'Accepted by provider', cls: 'bg-accent-soft text-accent border-accent', title: 'The provider accepted this message. That is not proof it arrived — for a text, a delivery confirmation follows separately; for an email there is none.' };
    case 'bounced':
      return { text: 'Bounced', cls: 'bg-danger-soft text-danger border-danger', title: 'The provider reported a hard bounce — the address or number does not accept messages.' };
    case 'skipped':
      return { text: 'Not sent', cls: 'bg-warn-soft text-warn border-warn', title: 'The system deliberately did not send this. The reason is shown beside it.' };
    case 'failed':
      // Two different events share this: rejected at the API, or reported undelivered afterwards by
      // the network. The row's `error` carries the provider's own code and is rendered beside this,
      // which is what separates "wrong number" from "carrier refused it".
      return { text: 'Not delivered', cls: 'bg-danger-soft text-danger border-danger', title: 'The provider rejected this message, or the network reported it as undelivered. The reason is shown beside it.' };
    case 'queued':
      return { text: 'Queued', cls: 'bg-surface-muted text-muted border-line', title: 'Recorded but not yet handed to a provider.' };
    case 'received':
      // INBOUND. "Received" is a fact we witnessed, unlike delivery of anything we send.
      return { text: 'Received', cls: 'bg-accent-soft text-accent border-accent', title: 'This message arrived from the customer.' };
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
  threadId, jobCardId, reachability, canSend = false, onSent, smsAllowance: initialAllowance,
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
  /** Server-resolved on load. Refreshed by this component when the channel changes or a text sends. */
  smsAllowance?: SmsAllowance | null;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  // Reachability is CHANNEL-SHAPED — a customer with a mobile and no email is reachable by one and
  // not the other — so switching re-asks the server rather than reusing the answer to a different
  // question. The prop is the initial (email) answer; this holds whatever the current channel's is.
  const [reach, setReach] = useState<Reachability | null | undefined>(reachability);
  const [allowance, setAllowance] = useState<SmsAllowance | null>(initialAllowance ?? null);
  const [switching, setSwitching] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);

  React.useEffect(() => { setReach(reachability); }, [reachability]);

  async function pickChannel(next: 'email' | 'sms') {
    if (next === channel) return;
    setChannel(next); setNote(null); setSwitching(true);
    try {
      const q = new URLSearchParams({ channel: next, ...(threadId ? { threadId } : { jobCardId: jobCardId as string }) });
      const r = await fetch(`/api/messages/send?${q}`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (d?.reachability !== undefined) setReach(d.reachability);
      if (d?.smsAllowance) setAllowance(d.smsAllowance);
    } catch {
      // Leave the previous answer in place and say nothing: a failed lookup must not silently
      // present the OTHER channel's reachability as though it were this one's.
      setNote({ text: 'Could not check whether this customer can be texted.', ok: false });
    } finally { setSwitching(false); }
  }

  async function topUp() {
    setToppingUp(true);
    try {
      const r = await fetch('/api/sms-topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packs: 1 }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.url) { window.location.href = d.url; return; }
      setNote({ text: d?.message || 'Could not start the top-up.', ok: false });
    } catch { setNote({ text: 'Could not start the top-up.', ok: false }); }
    finally { setToppingUp(false); }
  }

  async function send() {
    if ((!threadId && !jobCardId) || !text.trim()) return;
    setBusy(true); setNote(null);
    try {
      const r = await fetch('/api/messages/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // CHANNEL IS A FIELD. No selector yet — there is nothing to select while SMS is unconfigured.
        body: JSON.stringify(threadId ? { threadId, body: text, channel } : { jobCardId, body: text, channel }),
      });
      const d = await r.json().catch(() => ({}));
      // The allowance comes back on success AND on the allowance refusal, so the count on screen is
      // never one send behind what the server thinks.
      if (d?.smsAllowance) setAllowance(d.smsAllowance);
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
  const closed = !target || !canSend || !reach || reach.ok !== true;
  // Spent is not the same as unconfigured: one is bought back, the other is not the garage's doing.
  const spent = channel === 'sms' && !!allowance && allowance.remaining <= 0;

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
              <li key={m.id} data-testid="conversation-item" data-status={m.status} data-direction={m.direction}
                  className={`border rounded-xl p-3 ${m.direction === 'in' ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-ink">{TEMPLATE_LABEL[m.template] ?? m.template}</span>
                  <span className="uppercase tracking-wide text-muted border border-line rounded px-1.5 py-0.5">{m.channel}</span>
                  {m.direction === 'in'
                    ? <span className="text-accent font-semibold" title="This came FROM the customer.">↙ Inbound</span>
                    : <span className="text-muted" title="Sent by the garage.">↗ Outbound</span>}
                  <span className={`rounded-full border px-2 py-0.5 ${chip.cls}`} title={chip.title} data-testid={`status-${m.status}`}>{chip.text}</span>
                  <span className="ml-auto text-muted tabular-nums" data-testid="conversation-time">{fmt(m.at, locale)}</span>
                </div>
                <div className="mt-1 text-xs text-muted break-all">
                  {m.direction === 'in' ? <>From {m.recipient}</> : <>To {m.recipient}</>}
                  {m.subject ? <> · <span className="text-ink">{m.subject}</span></> : null}
                  {m.direction === 'out' && <>
                    {' · '}
                    {/* WHO sent it. Null is the system, and it says so — it does not borrow a name. */}
                    <span data-testid="sent-by">{m.sentByName ? `Sent by ${m.sentByName}` : 'Sent automatically'}</span>
                  </>}
                </div>
                {m.direction === 'in' && !m.body && (
                  <p className="mt-2 text-xs text-warn" data-testid="body-pending">
                    The message text hasn&rsquo;t been retrieved yet — the arrival is recorded and the text will follow.
                  </p>
                )}
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
          {/* ── HOW IT GOES ──────────────────────────────────────────────────────────────────
              Two buttons rather than a dropdown: there are two channels and the choice changes
              what the box says about reachability, so it should be visible rather than folded
              away. Switching re-asks the server — a customer with a mobile and no email is
              reachable by one and not the other. */}
          <div className="flex items-center gap-2 mb-2" data-testid="compose-channel">
            {(['email', 'sms'] as const).map((c) => (
              <button
                key={c} type="button" onClick={() => pickChannel(c)} disabled={busy || switching}
                data-testid={`channel-${c}`} aria-pressed={channel === c}
                className={`text-xs font-semibold rounded-lg px-3 py-1.5 border transition-colors disabled:opacity-50 ${
                  channel === c ? 'bg-accent text-white border-accent' : 'bg-surface text-muted border-line hover:text-ink'
                }`}
              >
                {c === 'email' ? 'Email' : 'Text'}
              </button>
            ))}
            {channel === 'sms' && allowance && (
              // THE REMAINING COUNT, not a price. The £75 includes a hundred a month and top-ups
              // come in hundreds, so what a garage can act on is the balance.
              <span className="text-xs text-muted ml-1" data-testid="sms-allowance">
                {allowance.remaining} text{allowance.remaining === 1 ? '' : 's'} left
                {allowance.topUpRemaining > 0 && allowance.includedRemaining === 0 ? ' (from your top-up)' : ''}
              </span>
            )}
            {channel === 'sms' && spent && (
              <button
                type="button" onClick={topUp} disabled={toppingUp} data-testid="sms-topup"
                className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-accent text-white disabled:opacity-50 ml-auto"
              >
                {toppingUp ? 'Opening…' : 'Top up 100'}
              </button>
            )}
          </div>

          {/* Spent is its OWN state, not a closed box. The customer is perfectly reachable; it is
              we who cannot send, and the remedy is a purchase rather than a data fix. Email stays
              available beside it, which is usually the faster answer. */}
          {spent && !closed && (
            <div className="mb-2 text-sm rounded-lg bg-warn-soft border-l-4 border-warn p-3" data-testid="compose-allowance-spent">
              <p className="text-ink">
                Your texts are used up for this month{allowance ? ` — ${allowance.usedThisMonth} sent` : ''}.
                They reset on {allowance ? new Date(allowance.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'the 1st'}.
              </p>
              <p className="text-muted mt-1">Top up to keep texting, or switch to email — it costs nothing and reaches the same customer.</p>
            </div>
          )}

          {closed ? (
            <div className="text-sm text-muted border border-dashed border-line rounded-xl p-4" data-testid="compose-closed">
              {reach && reach.ok === false
                ? reach.reason
                : 'This conversation cannot be written to.'}
            </div>
          ) : (
            <>
              <label className="block text-xs uppercase text-muted mb-1" htmlFor="compose-body">Send a message</label>
              <textarea
                id="compose-body" data-testid="compose-body" rows={3} value={text} disabled={busy}
                onChange={(e) => setText(e.target.value)} maxLength={2000}
                placeholder={`Write to ${reach!.customerName}…`}
                className="w-full p-2.5 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent"
              />
              <div className="flex items-center gap-3 mt-1.5">
                <button
                  type="button" onClick={send} disabled={busy || switching || spent || !text.trim()} data-testid="compose-send"
                  className="rounded-lg px-4 py-2 text-sm font-semibold text-white bg-accent disabled:opacity-50"
                >
                  {busy ? 'Sending…' : switching ? 'Checking…' : channel === 'sms' ? 'Send text' : 'Send'}
                </button>
                <span className="text-xs text-muted">
                  Goes to {(reach as { address: string }).address} by {channel === 'sms' ? 'text' : 'email'}. Replies come back to the garage.
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
