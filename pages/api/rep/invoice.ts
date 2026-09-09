/**
 * File: pages/api/rep/invoice.ts
 * THE REP SUBMITS THEIR INVOICE. One caller of lib/rep-invoice-submit, and it injects nothing.
 *
 * No renderer is passed, so the real .tsx renderer runs — rep-invoice-gate asserts that, because
 * the gate itself injects a stub (node's type-stripping cannot transform JSX) and an API route that
 * quietly did the same would leave the real document untested by anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireRepApi } from '@/lib/rep-auth';
import { submitRepInvoice } from '@/lib/rep-invoice-submit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const rep = await requireRepApi(req, res);
  if (!rep) return;

  const r = await submitRepInvoice({
    repId: rep.repId,                                   // FROM THE SESSION, never from the body
    payRunId: String(req.body?.payRunId ?? ''),
    number: String(req.body?.number ?? ''),
  });
  if (!r.ok) return res.status(409).json({ code: r.code, message: r.message });
  //  ^ 409, not 400. Every refusal here is "not yet / not like this", and the outbox rule applies:
  //    400 reads as terminal, and a rep whose profile is one field short must be told to come back.
  return res.status(200).json({ invoiceId: r.invoiceId, number: r.number });
}
