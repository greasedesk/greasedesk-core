/**
 * File: pages/api/superadmin/marketing.ts
 * THE ENGINE ROOM'S DOOR INTO THE MARKETING ENGINE — the four switches, the copy, a preview, and a
 * test send. One route with an `action`, because every one of these is the same question asked about
 * the same four sequences and splitting them into five files would put the authorisation rule in
 * five places.
 *
 * ── OWNER-ONLY FOR EVERY WRITE, AND THE SWITCH IS THE REASON ───────────────────────────────────
 * Turning a sequence on emails real people, and there is no undo on a sent email. Reading is open to
 * any operator — a support operator should be able to see what a garage was sent — and 404 rather
 * than 403 on refusal, per Engine Room discipline: an operator who may not do this must not learn
 * that the thing exists.
 *
 * The audit row for a switch is written inside lib/marketing-store::setSending, in the same
 * transaction as the switch itself, so there is no path that changes it without recording who did.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireOperatorApi, roleAtLeast } from '@/lib/operator-auth';
import { isSequenceKey, isStep, SEQUENCE_KEYS } from '@/lib/marketing-engine';
import { allSwitchStates, copyFor, previewStep, saveCopy, sendTest, setSending } from '@/lib/marketing-store';
import { marketingFromAddress, marketingFromConfigured } from '@/lib/email-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const op = await requireOperatorApi(req, res);
  if (!op) return;

  if (req.method === 'GET') {
    const switches = await allSwitchStates();
    const copy = Object.fromEntries(await Promise.all(SEQUENCE_KEYS.map(async (k) => [k, await copyFor(k)])));
    // THE FROM ADDRESS IS PART OF THE ANSWER, not a separate screen. Somebody deciding whether to
    // switch a sequence on needs to know whether it will leave from the marketing subdomain or from
    // the domain the invoices use — see docs/marketing-subdomain-dns.md.
    return res.status(200).json({ switches, copy, from: { address: marketingFromAddress(), onMarketingDomain: marketingFromConfigured() } });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ message: 'Method not allowed.' }); }
  if (!roleAtLeast(op.role, 'owner')) return res.status(404).json({ message: 'Not found.' });

  const b = (req.body || {}) as Record<string, unknown>;
  const sequence = String(b.sequence ?? '');
  if (!isSequenceKey(sequence)) return res.status(400).json({ message: 'Unknown sequence.' });

  switch (String(b.action ?? '')) {
    case 'switch': {
      if (typeof b.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false.' });
      await setSending({ sequence, enabled: b.enabled, operatorId: op.userId });
      return res.status(200).json({ ok: true, switches: await allSwitchStates() });
    }
    case 'save-copy': {
      const step = Number(b.step);
      if (!isStep(step)) return res.status(400).json({ message: 'Unknown step.' });
      const r = await saveCopy({
        sequence, step,
        subject: String(b.subject ?? ''), body: String(b.body ?? ''),
        ctaLabel: b.ctaLabel == null ? null : String(b.ctaLabel),
        ctaUrl: b.ctaUrl == null ? null : String(b.ctaUrl),
        operatorId: op.userId,
      });
      if (!r.ok) return res.status(400).json({ message: r.message });
      return res.status(200).json({ ok: true, copy: await copyFor(sequence), switches: await allSwitchStates() });
    }
    case 'preview': {
      const step = Number(b.step);
      if (!isStep(step)) return res.status(400).json({ message: 'Unknown step.' });
      const r = await previewStep(sequence, step);
      if (!r.ok) return res.status(400).json({ message: r.message });
      return res.status(200).json({ ok: true, subject: r.subject, html: r.html });
    }
    case 'send-test': {
      const step = Number(b.step);
      if (!isStep(step)) return res.status(400).json({ message: 'Unknown step.' });
      const r = await sendTest({ sequence, step, to: String(b.to ?? ''), operatorId: op.userId });
      if (!r.ok) return res.status(400).json({ message: r.message });
      return res.status(200).json({ ok: true });
    }
    default:
      return res.status(400).json({ message: 'Unknown action.' });
  }
}
