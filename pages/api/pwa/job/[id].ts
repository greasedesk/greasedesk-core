/**
 * File: pages/api/pwa/job/[id].ts
 * GET → the phone's READ-ONLY job card: customer, vehicle (VIN is the anchor grain), the work
 * sold, notes, invoice state. Session-resolved; the client sends no identity. Money is governed
 * by the EXISTING financeVisibility shaping inside buildJobCardPageProps (one truth — not
 * re-implemented here): a price-blind user receives no unit_price because the shaper already
 * stripped it. This endpoint then projects a lean phone shape and NEVER carries unit_cost —
 * for ANY role, ADMIN included (the shared shaper would send it to a cost-visible user; the
 * phone drops the field: a parts factor call needs the VIN, never the trade price).
 * Photos are NOT here — the page lazy-loads them from the existing GET /api/photos (presigned
 * URLs expire; the card TEXT is what must cache offline).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { buildJobCardPageProps } from '@/lib/jobcard-page-data';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store'); // offline freshness is the client cache's job
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ message: 'Missing id.' });

  // THE shared builder = the visibility + finance chokepoint (site scope inside; null = not yours).
  const p = await buildJobCardPageProps(user.id as string, user.group_id as string, id);
  if (!p) return res.status(404).json({ message: 'Job card not found.' });

  return res.status(200).json({
    id: p.jobCardId,
    status: p.status,
    isComeback: p.isComeback,
    customer: { name: p.owner.name, phone: p.owner.phone },
    vehicle: {
      registration: p.vehicle.registration,
      make: p.vehicle.make, model: p.vehicle.model, colour: p.vehicle.colour,
      vin: p.vehicle.vin,
      mileageIn: p.vehicle.mileageIn,
    },
    // Work sold — NO money fields, for anyone: no unitPrice, no unit_cost. Descriptions and
    // quantities are the job; the sell price has no use in a bay.
    lines: p.lines.map((l) => ({
      type: l.item_type,
      description: l.description,
      qty: l.qty,
      hours: l.labour_hours ?? null,
    })),
    notes: p.garageNotes || '',
    invoice: p.invoice ? { number: p.invoice.number, status: p.invoice.status } : null,
    currency: p.currency,
    locale: p.locale,
  });
}
