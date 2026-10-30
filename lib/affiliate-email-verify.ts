/**
 * File: lib/affiliate-email-verify.ts
 * PROVING AN AFFILIATE'S EMAIL ADDRESS — mint a link, spend it once, stamp the row.
 *
 * ── WHY NOT lib/rep-magic-link ─────────────────────────────────────────────────────────────────
 * It reuses that module's STORE (RepMagicLink) and its primitives (newMagicToken, hashToken), and
 * none of its behaviour, because the two links are not the same thing:
 *
 *   sign_in       is a CREDENTIAL. Spending it starts a session, so minting one revokes the others
 *                 — two live ways into an account is one more than anybody needs.
 *   email_verify  proves an ADDRESS was reachable. Spending it starts nothing and grants nothing;
 *                 it stamps a date and renders a sentence.
 *
 * Mixing them would mean a verification link that could be traded for a session, or a sign-in link
 * silently revoked by somebody confirming their address. The `purpose` column is what keeps them
 * apart at the lookup, and RepMagicLink_purpose_chk is what stops a typo inventing a third kind.
 *
 * ── THE PORTAL IS NOT THIS SLICE ───────────────────────────────────────────────────────────────
 * There is no affiliate portal yet, so there is deliberately no sign-in link in the welcome email:
 * a button pointing at a door that is not built is worse than no button. When the portal lands it
 * mints `sign_in` through rep-magic-link as a rep does, on the affiliate host, and this stays
 * exactly as it is.
 */
import { prisma } from '@/lib/db';
import { hashToken } from '@/lib/tokens';
import { newMagicToken } from '@/lib/magic-link';

type Db = any; // a PrismaClient or an interactive-transaction client

/**
 * HOW LONG A VERIFICATION LINK LASTS. Days, not the sign-in link's minutes, and for a different
 * reason than generosity: a credential short enough to be useless if intercepted is right for a
 * session, while this one is read when somebody gets round to their email. The thing it protects is
 * the claim "this address was reachable", which does not decay in an afternoon.
 */
export const EMAIL_VERIFY_DAYS = 14;
export const EMAIL_VERIFY_PURPOSE = 'email_verify';

export type MintedVerifyLink = { rawToken: string; url: string; expiresAt: Date };

/** The address a verification link is served at, on the affiliate host. */
export const verifyLinkUrl = (rawToken: string, baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/affiliate-site/confirm-email/${rawToken}`;

/**
 * Mint one. Supersedes this affiliate's other UNSPENT verification links — a person who asks again
 * is telling us the first did not arrive, and two live links prove nothing extra.
 *
 * SCOPED TO THE PURPOSE in both the revoke and the create, so minting this can never touch a
 * sign-in link. That is the whole reason this function exists instead of a flag on the other one.
 */
export async function mintEmailVerifyLink(args: { repId: string; sentTo: string; baseUrl: string; db?: Db }): Promise<MintedVerifyLink> {
  const db: Db = args.db ?? prisma;
  await db.repMagicLink.updateMany({
    where: { rep_id: args.repId, purpose: EMAIL_VERIFY_PURPOSE, consumed_at: null, revoked_at: null },
    data: { revoked_at: new Date(), revoked_reason: 'superseded' },
  });
  const raw = newMagicToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFY_DAYS * 24 * 60 * 60 * 1000);
  await db.repMagicLink.create({
    data: {
      rep_id: args.repId,
      purpose: EMAIL_VERIFY_PURPOSE,
      token_hash: hashToken(raw),
      sent_to: args.sentTo,
      expires_at: expiresAt,
    },
    select: { id: true },
  });
  return { rawToken: raw, url: verifyLinkUrl(raw, args.baseUrl), expiresAt };
}

export type VerifySpend =
  | { ok: true; repId: string; alreadyDone: boolean }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'used'; message: string };

/**
 * Spend it, and stamp the row — the two are one act, because a verification that does not record
 * itself is theatre.
 *
 * EVERY REFUSAL IS DISTINGUISHABLE to the caller and the SENTENCES differ, unlike a code's, because
 * these are not guesses: nobody brute-forces a 64-hex token, so there is no attacker to starve of
 * information and a person holding an old email deserves to know which old thing it is.
 *
 * ALREADY STAMPED IS A SUCCESS. A person who clicks the same link twice, or clicks a new link after
 * an older one worked, has done nothing wrong and their address is no less proved. `alreadyDone`
 * lets the page say something true without making it sound like a failure.
 */
export async function spendEmailVerifyLink(rawToken: string, db: Db = prisma): Promise<VerifySpend> {
  const row = await db.repMagicLink.findUnique({
    where: { token_hash: hashToken(rawToken) },
    select: { id: true, rep_id: true, purpose: true, expires_at: true, consumed_at: true, revoked_at: true },
  });
  // A SIGN-IN TOKEN PRESENTED HERE IS 'unknown', not 'used'. The purpose check is part of the
  // lookup's meaning: this endpoint has never heard of that token, and saying anything more
  // specific would confirm it exists.
  if (!row || row.purpose !== EMAIL_VERIFY_PURPOSE) {
    return { ok: false, reason: 'unknown', message: 'That link isn’t one of ours, or it has been replaced by a newer one.' };
  }
  if (row.revoked_at) return { ok: false, reason: 'revoked', message: 'That link was replaced by a newer one. Use the most recent email we sent you.' };
  if (row.consumed_at) {
    // Spent ALREADY, by this same link: the address is proved and saying "expired" would be a lie.
    const rep = await db.rep.findUnique({ where: { id: row.rep_id }, select: { email_verified_at: true } });
    return rep?.email_verified_at
      ? { ok: true, repId: row.rep_id, alreadyDone: true }
      : { ok: false, reason: 'used', message: 'That link has already been used.' };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired', message: `That link has expired — they last ${EMAIL_VERIFY_DAYS} days. Ask us for another.` };
  }

  const now = new Date();
  await db.$transaction([
    db.repMagicLink.update({ where: { id: row.id }, data: { consumed_at: now } }),
    // FIRST STAMP WINS. A second confirmation does not move the date: when the address was proved
    // is a fact about the first time it happened.
    db.rep.updateMany({ where: { id: row.rep_id, email_verified_at: null }, data: { email_verified_at: now } }),
  ]);
  return { ok: true, repId: row.rep_id, alreadyDone: false };
}
