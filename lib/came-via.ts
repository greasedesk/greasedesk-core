/**
 * File: lib/came-via.ts
 * WHERE DID THIS GARAGE COME FROM — assembled from the records that already answer it, in one
 * reader, so the Engine Room shows the same answer the money was paid on.
 *
 * ── WHY THIS EXISTS: THE ONE-LINE VERSION WAS WRONG ────────────────────────────────────────────
 * The tenant page derived a "Signup source" string inline:
 *
 *     attribCount > 0 ? `Reseller (ref …)` : ref ? 'Referral (ref …)' : waitlist ? 'Waitlist' : 'Direct'
 *
 * TenantAttribution has carried `party_type` since affiliates shipped, and that expression never
 * looked at it — so every garage introduced by an AFFILIATE was labelled a reseller signup on the
 * one screen an operator uses to check who introduced whom. A reseller is paid on a taper by a pay
 * run; an affiliate is paid four instalments against frozen terms. Reading the wrong one off the
 * screen is the kind of mistake that gets found in a conversation about money.
 *
 * ── FOUR ANSWERS, AND "DIRECT" IS A REAL ONE ───────────────────────────────────────────────────
 * affiliate · reseller · a code nobody holds · nobody. The last is reported as DIRECT, because a
 * referral code that reaches the signup form is submitted WITH the form (no cookie, no consent) —
 * so its absence means no code was presented, and that is a fact about the signup rather than a
 * gap in our records. It is still shown with the reason, not as a bare word.
 *
 * ── AND A DISAGREEMENT IS ITS OWN ANSWER ───────────────────────────────────────────────────────
 * The frozen TenantAffiliateTerms row and the active TenantAttribution are written together at
 * signup and cannot disagree by the normal path. By a hand-made one they can, and then there is no
 * right answer to show: `conflict` carries both and asks for a human. Picking the first would be a
 * guess about who is owed money, printed as a fact.
 *
 * ── THE MARKETING ANSWERS ARE A SEPARATE AXIS, AND THEY ARE ABSENT MUCH MORE OFTEN ─────────────
 * heard_about and utm_* are NULL for every garage that signed up before 2026-10-30, for anyone who
 * skips an optional question, and for anyone who refused the functional cookie. They are reported
 * as NOT RECORDED and never folded into the referrer axis: "we don't know how they heard of us" and
 * "nobody referred them" are different sentences, and only one of them is about money.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { heardAboutLabel, HEARD_ABOUT_OTHER, type UtmParts } from '@/lib/signup-source';

type Db = PrismaClient | Prisma.TransactionClient;

export type CameViaParty = {
  partyId: string;
  name: string;
  refCode: string;
  /** NULL = not suspended. Shown because a suspended introducer is what an operator is looking for. */
  suspendedAt: string | null;
};

/**
 * `frozen` is a FIELD of the party answer rather than two separate kinds, because the question it
 * answers is not "which kind of partner" but "is there a document saying what this garage's reward
 * is". An affiliate attributed by the deferred path has no frozen terms row, and a reseller never
 * has one at all. A union of `frozen: true` and `frozen: false` members would have needed a cast
 * at the one place that builds it — and a cast is where the compiler stops checking.
 */
export type CameViaReferrer =
  | ({ kind: 'affiliate' | 'reseller'; since: string; frozen: boolean } & CameViaParty)
  | { kind: 'unmatched_code'; code: string }
  | { kind: 'conflict'; detail: string }
  | { kind: 'direct' };

export type CameViaHeardAbout = {
  value: string;
  /** The current copy for that value, or the value itself when the copy has moved on. */
  label: string;
  /** The free text, only ever present on the "something else" answer. */
  other: string | null;
};

export type CameVia = {
  referrer: CameViaReferrer;
  /** NULL = NOT RECORDED. Not "direct", and not an empty answer. */
  heardAbout: CameViaHeardAbout | null;
  /** All-null = not recorded: no campaign on the URL, or functional consent refused. */
  utm: UtmParts;
  /** Did they come in off a country waiting list? A fact about admission, not about a referrer. */
  fromCountryWaitlist: boolean;
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * ASSEMBLE IT. One group, four reads, no writes. Returns `direct` for a group that presented no
 * code — never throws over a missing record, because an operator looking at a tenant page while
 * one of these tables is unreachable needs the rest of the page.
 */
export async function cameVia(db: Db, groupId: string): Promise<CameVia> {
  const g = await (db as any).group.findUnique({
    where: { id: groupId },
    select: {
      signup_ref: true, heard_about: true, heard_about_other: true,
      utm_source: true, utm_medium: true, utm_campaign: true,
    },
  });
  if (!g) throw new Error(`CAME_VIA: group ${groupId} not found`);

  const [terms, active, waitlist] = await Promise.all([
    // THE FROZEN TERMS, which is the affiliate record money is owed against. group_id is @unique:
    // one row or none, and none means never referred by an affiliate.
    (db as any).tenantAffiliateTerms.findUnique({
      where: { group_id: groupId },
      select: { signed_up_at: true, affiliate: { select: { id: true, name: true, ref_code: true, suspended_at: true } } },
    }),
    (db as any).tenantAttribution.findMany({
      where: { group_id: groupId, ended_at: null },
      select: { party_type: true, party_id: true, effective_from: true },
    }),
    (db as any).countryWaitlist.count({ where: { group_id: groupId } }).catch(() => 0),
  ]);

  const utm: UtmParts = { source: g.utm_source ?? null, medium: g.utm_medium ?? null, campaign: g.utm_campaign ?? null };
  const value = (g.heard_about ?? null) as string | null;
  const heardAbout: CameViaHeardAbout | null = value
    ? {
        value,
        label: heardAboutLabel(value) ?? value,
        // The free text belongs to one answer. A stray value on any other is not shown rather than
        // shown next to an option it does not describe.
        other: value === HEARD_ABOUT_OTHER ? ((g.heard_about_other ?? null) as string | null) : null,
      }
    : null;

  const base = { heardAbout, utm, fromCountryWaitlist: waitlist > 0 };
  const repAttrib = active.find((a: any) => a.party_type === 'rep');
  const affAttrib = active.find((a: any) => a.party_type === 'affiliate');

  // 1. THE FROZEN AFFILIATE TERMS WIN, when they exist — that is the document the reward is owed on.
  if (terms?.affiliate) {
    // …unless an active RESELLER attribution is also on the group, which no path writes and which
    // nobody can resolve from a screen.
    if (repAttrib) {
      return {
        ...base,
        referrer: {
          kind: 'conflict',
          detail: `frozen affiliate terms name ${terms.affiliate.ref_code}, and an active reseller attribution names party ${repAttrib.party_id} — one garage cannot have been introduced by both`,
        },
      };
    }
    return {
      ...base,
      referrer: {
        kind: 'affiliate' as const, frozen: true,
        partyId: terms.affiliate.id, name: terms.affiliate.name, refCode: terms.affiliate.ref_code,
        suspendedAt: iso(terms.affiliate.suspended_at),
        since: (terms.signed_up_at as Date).toISOString(),
      },
    };
  }

  // 2. A RESELLER, from the active attribution — there is no per-tenant frozen terms row for a rep
  //    (the rate is effective-dated and resolved at collection), so the attribution IS the record.
  const partyAttrib = repAttrib ?? affAttrib;
  if (partyAttrib) {
    const party = await (db as any).rep.findUnique({
      where: { id: partyAttrib.party_id },
      select: { name: true, ref_code: true, suspended_at: true, party_type: true },
    });
    if (party) {
      // An AFFILIATE attribution with no frozen terms row is a real state — a signup whose code
      // resolved after the fact (the deferred path) attributes without freezing terms. It is
      // reported as an affiliate, and `frozen: false` is the part an operator needs to notice,
      // because there is no document saying what that garage's reward was.
      const kind = partyAttrib === affAttrib ? ('affiliate' as const) : ('reseller' as const);
      return {
        ...base,
        referrer: {
          kind, frozen: false,
          partyId: partyAttrib.party_id, name: party.name, refCode: party.ref_code,
          suspendedAt: iso(party.suspended_at),
          since: (partyAttrib.effective_from as Date).toISOString(),
        },
      };
    }
  }

  // 3. A CODE THAT RESOLVED TO NOBODY. The ref survives untouched by design (lib/attribution), so
  //    this is the state of a garage that typed a code we have never issued — or one that belongs
  //    to an affiliate who has not joined yet, in which case it resolves later on its own.
  const code = (g.signup_ref ?? '').trim();
  if (code) return { ...base, referrer: { kind: 'unmatched_code', code } };

  // 4. NOBODY. No code reached the form, and the form submits one without needing a cookie.
  return { ...base, referrer: { kind: 'direct' } };
}

/** One sentence for the screen. Separate from the data so a gate can assert the words. */
export function referrerSentence(r: CameViaReferrer): string {
  switch (r.kind) {
    case 'affiliate': return `Affiliate — ${r.name} (${r.refCode})`;
    case 'reseller': return `Reseller — ${r.name} (${r.refCode})`;
    case 'unmatched_code': return `A referral code we cannot match: ${r.code}`;
    case 'conflict': return `Needs a human: ${r.detail}`;
    case 'direct': return 'Direct — no referral code was presented at signup';
  }
}
