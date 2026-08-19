/**
 * File: components/jobcard/SendIntakeReport.tsx
 * SEND THE INTAKE REPORT — and tell the garage what they are sending before they send it.
 *
 * ── THE SHAREABLE-LINK WARNING BELONGS HERE ─────────────────────────────────────────────────────
 * Not in Terms, which nobody reads at the moment of deciding. A garage should know BEFORE pressing
 * send that the link contains video of the customer's car and that whoever receives it can forward
 * it to anyone. That is the same exposure a quote or invoice link carries — but a walkaround of
 * someone's vehicle FEELS different, and a warning that arrives after the fact is not a warning.
 *
 * Stated plainly, once, next to the button. Not a checkbox: consent theatre for a routine action
 * trains people to click past it, and the garage is not the data subject here anyway.
 */
import React, { useState } from 'react';

type Props = {
  jobCardId: string;
  canSend: boolean;
  findingCount: number;
  /** Derived (lib/due-items::reportStatus) — never a stored flag. */
  status: { state: 'not_sent' } | { state: 'awaiting' | 'partial'; sentAt: string; days: number; answered: number; total: number } | { state: 'all_answered'; sentAt: string; answered: number };
};

type Result = { sent: boolean; channel: string; sentTo: string | null; url: string; refusal: string | null; retryable: boolean };

export default function SendIntakeReport({ jobCardId, canSend, findingCount, status }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  async function send(channel: 'sms' | 'email') {
    setBusy(channel); setResult(null);
    try {
      const r = await fetch('/api/intake-report-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, channel }),
      });
      const d = await r.json();
      if (r.ok) setResult(d);
    } finally { setBusy(null); }
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5" data-testid="send-intake-report">
      <h3 className="text-sm font-semibold text-ink mb-1">Send the check-in to the customer</h3>
      <p className="text-sm text-muted mb-3">
        The walkaround, the photos, and {findingCount === 0 ? 'the fact you found nothing' : `${findingCount} thing${findingCount === 1 ? '' : 's'} you found`}.
        {' '}No prices — they tell you what they want quoted.
      </p>

      {/* DERIVED STATUS. "No reply" is an absence, not an event: nothing fires, the card just says so. */}
      {status.state === 'awaiting' && (
        <p className="text-sm text-warn mb-3" data-testid="report-awaiting">
          Sent {status.days === 0 ? 'today' : `${status.days} day${status.days === 1 ? '' : 's'} ago`} — no reply yet.
        </p>
      )}
      {status.state === 'partial' && (
        <p className="text-sm text-warn mb-3" data-testid="report-partial">
          {status.answered} of {status.total} answered — sent {status.days === 0 ? 'today' : `${status.days} day${status.days === 1 ? '' : 's'} ago`}.
        </p>
      )}
      {status.state === 'all_answered' && (
        <p className="text-sm text-ok mb-3" data-testid="report-all-answered">
          All {status.answered} answered. Their choices are on each finding.
        </p>
      )}

      {canSend && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy !== null} onClick={() => send('sms')} data-testid="send-report-sms"
            className="text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 disabled:opacity-50">
            {busy === 'sms' ? 'Sending…' : status.state === 'not_sent' ? 'Send by text' : 'Send again by text'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => send('email')} data-testid="send-report-email"
            className="text-sm font-semibold bg-accent-soft text-accent rounded-lg px-4 py-2.5 disabled:opacity-50">
            {busy === 'email' ? 'Sending…' : 'Send by email'}
          </button>
        </div>
      )}

      {/* BEFORE the button is pressed, not after. */}
      <p className="text-xs text-muted mt-3" data-testid="report-share-warning">
        This link shows video and photos of the customer’s car. Anyone who has the link can open it —
        if they forward it, whoever receives it can see it too.
      </p>

      {result && (
        <div className="mt-3 rounded-lg border border-line bg-surface-muted p-3" data-testid="send-report-result">
          <p className="text-sm text-ink">
            {result.sent
              ? <>Check-in {result.channel === 'sms' ? 'texted' : 'emailed'} to <span className="font-medium">{result.sentTo}</span>.</>
              // THE THREE SILENCES, in the server's own words — no address, blocked by policy, or
              // the provider refused. A garage that thinks the customer is ignoring them, when the
              // send never left, is the failure lib/send-outcome exists to prevent.
              : <span className="text-warn" data-testid="send-report-refusal">{result.refusal}</span>}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()}
              className="flex-1 p-2 text-xs bg-surface border border-line rounded-lg text-ink" />
            <button type="button" onClick={() => { navigator.clipboard?.writeText(result.url).then(() => setCopied(true)).catch(() => {}); }}
              className="text-xs font-semibold bg-surface-muted text-ink rounded-lg px-3 py-2">{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
