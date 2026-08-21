/**
 * File: pages/api/marketing-send.ts
 * POST { vehicleId, reason, channels } — send the reminder, and record that it went.
 *
 * The list used to answer "who do I ring" and record what a human then did elsewhere. This closes
 * the loop for the two channels we own: press once, the customer gets the message, and the row
 * records `contacted` with HOW it went out.
 *
 * ── THE ADDRESSES ARE RESOLVED HERE, NOT CARRIED BY THE PAGE ────────────────────────────────────
 * The row renders the phone number a garage recognises and nothing else. A list of two hundred
 * cars must not ship two hundred email addresses and mobile numbers into a browser to make a send
 * button work — the client names a CAR, and the server resolves who owns it now.
 *
 * ── WHICH WORDS, DECIDED BY THE BAND AND NOT BY THE CALLER ──────────────────────────────────────
 * motBand is the same function the list is built from, so the expired wording cannot be sent to a
 * car that is merely due (or the reverse) because a client posted the wrong flag. The client says
 * WHICH CAR; the server decides what is true about it.
 *
 * ── AND NOTHING HERE DECIDES WHETHER IT IS ALLOWED ──────────────────────────────────────────────
 * Opt-out, demo tenants, suppression and provider configuration are all sendNotification's, and
 * this must not pre-empt any of them: two places deciding who may be messaged is how one of them
 * drifts. What comes back is a per-channel outcome, and describeSendFailure turns it into a
 * sentence rather than this file inventing a second vocabulary for the same failures.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { sendNotification } from '@/lib/notify';
import { describeSendFailure, type FailedSend } from '@/lib/send-outcome';
import { motBand } from '@/lib/marketing-lists';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { writeAudit } from '@/lib/audit';
import { NOTIFICATION_TEMPLATES } from '@/lib/notification-templates';
import { smsText, smsCost } from '@/lib/sms-text';
import { contactRoute, noContactLabel } from '@/lib/marketing-lists';

const CHANNELS = ['sms', 'email'] as const;
type Ch = (typeof CHANNELS)[number];

const britishDate = (d: Date): string =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * GET is the PREVIEW — the same file, because the words a garage is shown and the words that go
 * out must not be able to differ. Rendering a preview in the component would be a second copy of
 * every sentence, and the second copy is the one that drifts.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const preview = req.method === 'GET';
  const vehicleId = preview
    ? (typeof req.query.vehicleId === 'string' ? req.query.vehicleId : null)
    : (typeof req.body?.vehicleId === 'string' ? req.body.vehicleId : null);
  if (!vehicleId) return res.status(400).json({ message: 'Which car?' });
  const asked: Ch[] = Array.isArray(req.body?.channels)
    ? (req.body.channels as string[]).filter((c): c is Ch => (CHANNELS as readonly string[]).includes(c))
    : [];
  if (!preview && !asked.length) return res.status(400).json({ message: 'Say which way to send it.' });

  const v = await prisma.vehicle.findFirst({
    where: { id: vehicleId, group_id: groupId },
    select: { id: true, registration: true, make: true, model: true, mot_expiry: true },
  });
  if (!v) return res.status(404).json({ message: 'Car not found.' });
  // NO EXPIRY, NO MESSAGE. A reminder whose whole content is a date cannot be sent without one,
  // and inventing "soon" would be a fabricated fact on a customer's phone.
  if (!v.mot_expiry) return res.status(400).json({ message: 'No MOT date for this car — check with DVSA first.' });

  const customerId = await getCurrentOwnerId(prisma as never, v.id);
  const cust = customerId
    ? await prisma.customer.findUnique({ where: { id: customerId },
        select: { name: true, email: true, phone: true, phone_e164: true, sms_opt_out: true, email_opt_out: true } })
    : null;
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, phone: true } });

  const band = motBand(v.mot_expiry, new Date());
  const template = band === 'expired' ? 'mot_expired' : 'mot_due';
  const data = {
    garageName: group?.group_name ?? 'Your garage',
    garagePhone: group?.phone ?? null,
    customerName: cust?.name ?? null,
    registration: v.registration,
    vehicleDesc: [v.make, v.model].filter(Boolean).join(' ') || 'car',
    expiryDate: britishDate(v.mot_expiry),
  };

  // ONE SUBJECT: THE CAR. Threads are keyed (group, customer, vehicle), and a reminder has no job
  // card behind it — see threadKeyForVehicle, added for exactly this send.
  const subject = { type: 'vehicle', id: v.id };

  if (preview) {
    const tpl = NOTIFICATION_TEMPLATES[template as keyof typeof NOTIFICATION_TEMPLATES] as
      { sms?: (d: typeof data) => { text: string }; email?: (d: typeof data) => { subject: string } };
    // THROUGH smsText, because that is what notify sends. A preview of the unfolded text would
    // show a garage a message with an em dash we do not transmit, and a segment count we would
    // not be billed for.
    const text = tpl.sms ? smsText(tpl.sms(data).text) : null;
    const route = cust ? contactRoute(cust) : { sms: false, email: false, phone: null };
    return res.status(200).json({
      template,
      sms: text ? { text, ...smsCost(text) } : null,
      emailSubject: tpl.email ? tpl.email(data).subject : null,
      canSms: route.sms, canEmail: route.email,
      // WHY NOT, said here rather than guessed by the row: no address on file is a different
      // problem from a recorded refusal, and they are fixed in different places.
      smsWhyNot: route.sms ? null : (cust?.sms_opt_out === true ? 'This customer has opted out of texts.' : 'No mobile number on file.'),
      emailWhyNot: route.email ? null : (cust?.email_opt_out === true ? 'This customer has opted out of email.' : 'No email address on file.'),
      noContact: cust ? noContactLabel(cust) : null,
      phone: cust?.phone ?? null,
    });
  }

  const results: Record<string, { ok: boolean; message: string; retryable?: boolean; code?: string }> = {};

  for (const channel of asked) {
    const recipient = channel === 'sms' ? cust?.phone_e164 : cust?.email;
    const sent = await sendNotification({
      groupId, template, channel, subject, data,
      recipient: recipient ?? '', sentByUserId: user.id as string,
    });
    results[channel] = sent.ok
      ? { ok: true, message: channel === 'sms' ? 'Text sent.' : 'Email sent.' }
      : { ok: false, ...describeSendFailure(sent as FailedSend, { channel, customerName: cust?.name }) };
  }

  // ── THE RECORD FOLLOWS WHAT ACTUALLY WENT ─────────────────────────────────────────────────────
  // Only channels that succeeded. Marking a car `contacted` because a send was ATTEMPTED would
  // drop it off the list on the strength of a message the customer never received — the one
  // outcome this feature must never produce.
  const went = asked.filter((c) => results[c]?.ok);
  const channel = went.length === 2 ? 'both' : went[0] ?? null;
  if (channel) {
    await prisma.marketingContact.upsert({
      // ONE ANSWER PER CAR — see the unique index on MarketingContact. `reason` records what this
      // send was about, and here it is known exactly: the template chosen from the car's own band.
      where: { group_id_vehicle_id: { group_id: groupId, vehicle_id: v.id } },
      create: { group_id: groupId, vehicle_id: v.id, reason: band === 'expired' ? 'mot_expired' : 'mot_due',
        state: 'contacted', for_date: v.mot_expiry, channel, actor_id: user.id as string },
      update: { state: 'contacted', reason: band === 'expired' ? 'mot_expired' : 'mot_due',
        for_date: v.mot_expiry, channel, snooze_until: null, actor_id: user.id as string },
    });
    await writeAudit(prisma, {
      groupId, userId: user.id as string, action: 'marketing.sent',
      entity: 'vehicle', entityId: v.id,
      diff: { registration: v.registration, template, channel, expiry: data.expiryDate },
    }).catch(() => {});
  }

  return res.status(200).json({ template, channel, results });
}
