/**
 * File: pages/api/affiliate-site/confirm.ts
 * STEP TWO: the code comes back, and the affiliate is approved. POST { email, code }.
 *
 * ── INSTANT APPROVAL MEANS NO HUMAN, NOT NO CHECK ──────────────────────────────────────────────
 * What is checked is the HANDSET: a code we texted, typed back inside its window. That is the one
 * thing standing between "somebody filled in a form" and "somebody we will send money to", so the
 * referral code is minted at signup and only HANDED OVER here.
 *
 * ── KEYED ON THE EMAIL, NOT ON AN ID WE HANDED OUT ─────────────────────────────────────────────
 * Step one returns no rep id. A uuid in a client's hands is a handle to somebody else's account,
 * and the only thing it would save is one lookup. The code itself is the secret and
 * lib/delivered-code counts the attempts against it.
 *
 * ── THE EMAIL IS SENT AFTER THE APPROVAL, AND ITS FAILURE IS NOT THE APPROVAL'S ────────────────
 * The welcome email carries the code, the link and the verification link. If it does not go, the
 * affiliate is still approved and still sees everything on screen — so the response is built first
 * and the send is reported beside it, never instead of it. Two independent things, the way
 * lib/reseller-interest has them.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { COMPANY, AFFILIATE_SITE_URL } from '@/lib/company-info';
import { PLATFORM_SEND, sendNotification } from '@/lib/notify';
import { currentTerms } from '@/lib/affiliate';
import { referralLink } from '@/lib/affiliate-join';
import { confirmPhoneVerification } from '@/lib/phone-verification';
import { mintEmailVerifyLink } from '@/lib/affiliate-email-verify';
import { publicPlanChoice } from '@/lib/plan-choice';
import { readEnvironment, revealTestOnlySecrets } from '@/lib/environment';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const email = String((req.body || {}).email ?? '').trim().toLowerCase();
  const typed = String((req.body || {}).code ?? '').trim();
  if (!email || !typed) return res.status(400).json({ ok: false, message: 'Give us the code we texted you.' });

  const rep = await prisma.rep.findUnique({
    where: { email },
    select: { id: true, party_type: true, ref_code: true, suspended_at: true, name: true },
  });
  // ONE SENTENCE FOR "no such signup" AND "that is a reseller", because this endpoint has proved
  // nothing about who is asking and the difference is not theirs to learn here.
  if (!rep || rep.party_type !== 'affiliate' || rep.suspended_at) {
    return res.status(400).json({ ok: false, message: 'We can’t match that. Start again from the signup form.' });
  }

  const confirmed = await confirmPhoneVerification({ type: 'rep', id: rep.id }, typed);
  if (!confirmed.ok) return res.status(400).json({ ok: false, message: confirmed.message });

  // ── APPROVED. Everything below is what they are handed, and none of it can fail the approval.
  const link = referralLink(rep.ref_code, COMPANY.siteUrl);
  // The QR is a data URL rendered here rather than a file: it is a picture of ONE string that is
  // already in the response, so writing it to storage would be a second copy to keep in step.
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 320 }).catch(() => null);

  const terms = await currentTerms(prisma);
  const choice = await publicPlanChoice(prisma, { referred: true });

  let emailed = false;
  let verifyUrl: string | null = null;
  try {
    const verify = await mintEmailVerifyLink({ repId: rep.id, sentTo: email, baseUrl: AFFILIATE_SITE_URL });
    verifyUrl = verify.url;
    const sent = await sendNotification({
      recipient: email,
      template: 'affiliate_welcome',
      channel: 'email',
      // A MESSAGE FROM GREASEDESK to somebody who is not a customer — stated, never inferred from
      // an absent tenant, which would silently disable the demo block and the opt-out check.
      groupId: PLATFORM_SEND,
      subject: { type: 'rep', id: rep.id },
      data: {
        refCode: rep.ref_code,
        referralLink: link,
        link: verify.url,
        monthsGiven: choice.annual.monthsGiven,
        monthsPaid: choice.annual.monthsPaid,
        expiryMinutes: null,
      },
    });
    emailed = sent.ok;
  } catch (e) {
    // LOUD AND NOT RETHROWN. They are approved; an email fault must not read as a failed signup.
    console.error('[affiliate-site/confirm] approved but the welcome email threw for', rep.id, e);
  }

  return res.status(200).json({
    ok: true,
    name: rep.name,
    refCode: rep.ref_code,
    link,
    qr,
    emailed,
    // THE REWARD, FROM THE SETTINGS, so the screen that says "you're in" can restate what they earn
    // without a second copy of the figures living in the page.
    reward: { totalPennies: terms.totalRewardPennies, instalmentPennies: terms.instalmentPennies },
    // IN THE TEST DATABASE ONLY, so a gate can follow the link it was never sent.
    //
    // KEYED ON THE MARKER, NOT ON `emailed`. The first draft of this line was
    // `emailed ? null : verifyUrl` — which reads as "only when nothing was sent" and is a hole:
    // a provider outage in PRODUCTION would have handed the verification link to whoever posted
    // the form, and signing up with somebody else's address would then prove it. The marker is a
    // row inside the data and fails closed in both other states, which is the same guard that
    // refused the send in the first place.
    verifyUrl: revealTestOnlySecrets(await readEnvironment(prisma)) ? verifyUrl : null,
  });
}
