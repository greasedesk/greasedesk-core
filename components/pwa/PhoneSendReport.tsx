/**
 * File: components/pwa/PhoneSendReport.tsx
 * SEND THE CHECK-IN FROM THE BAY — the button is here because the car is on the ramp.
 *
 * ── WHY A BUTTON AND NOT THE PANEL ──────────────────────────────────────────────────────────────
 * Capture-first: the value of the report is that it reaches the customer while the car is still
 * there, and walking to a desk is the delay this feature exists to remove. But the fuller desktop
 * panel also carries the derived reply status ("sent 3 days ago, no reply"), which is an OFFICE
 * concern — a mechanic does not chase responses. So the phone gets the action and not the ledger.
 *
 * ── AND THE WARNING COMES WITH IT ───────────────────────────────────────────────────────────────
 * The link contains video of the customer's car and is forwardable by whoever receives it. That
 * warning belongs wherever the decision is taken, which now includes here. It is NOT abbreviated
 * for the smaller screen: a shorter warning on the surface where sending is easiest would be
 * exactly the wrong trade.
 *
 * Posts directly rather than queuing: sending needs the network by definition, and a report queued
 * in a dead bay would surface to the customer at an unpredictable later moment.
 */
import React, { useState } from 'react';

export default function PhoneSendReport({ jobCardId, findingCount }: { jobCardId: string; findingCount: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: boolean; channel: string; sentTo: string | null; url: string; refusal: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  async function send(channel: 'sms' | 'email') {
    setBusy(channel); setResult(null);
    try {
      const r = await fetch('/api/intake-report-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, channel }),
      });
      if (r.ok) setResult(await r.json());
    } finally { setBusy(null); }
  }

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-send-report">
      <h2 className="text-sm font-semibold text-ink mb-1">Send the check-in</h2>
      <p className="text-xs text-muted mb-3">
        The walkaround, the photos, and {findingCount === 0 ? 'the fact you found nothing' : `${findingCount} thing${findingCount === 1 ? '' : 's'} you found`}. No prices.
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={busy !== null} onClick={() => send('sms')} data-testid="ph-send-sms"
          className="flex-1 min-h-[48px] text-sm font-semibold bg-accent text-white rounded-lg disabled:opacity-50">
          {busy === 'sms' ? 'Sending…' : 'Text it'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => send('email')} data-testid="ph-send-email"
          className="flex-1 min-h-[48px] text-sm font-semibold bg-accent-soft text-accent rounded-lg disabled:opacity-50">
          {busy === 'email' ? 'Sending…' : 'Email it'}
        </button>
      </div>
      <p className="text-xs text-muted mt-3" data-testid="ph-share-warning">
        This link shows video and photos of the customer’s car. Anyone who has the link can open it —
        if they forward it, whoever receives it can see it too.
      </p>
      {result && (
        <div className="mt-3 rounded-lg border border-line bg-surface-muted p-3" data-testid="ph-send-result">
          <p className="text-sm text-ink">
            {result.sent
              ? <>Sent to <span className="font-medium">{result.sentTo}</span>.</>
              : <span className="text-warn">{result.refusal}</span>}
          </p>
          <button type="button" onClick={() => { navigator.clipboard?.writeText(result.url).then(() => setCopied(true)).catch(() => {}); }}
            className="mt-2 min-h-[44px] w-full text-xs font-semibold bg-surface border border-line text-ink rounded-lg">
            {copied ? 'Link copied' : 'Copy the link'}
          </button>
        </div>
      )}
    </section>
  );
}
