/**
 * File: lib/party-portal.ts
 * WHERE EACH PARTY'S PORTAL LIVES. One table, read by the link builder, the guards and the pages.
 *
 * ── WHY THIS IS NOT A STRING IN THE CALLER'S HAND ───────────────────────────────────────────────
 * A rep and an affiliate are the same row in the same table (Rep.party_type) with the same
 * credential mechanism, and their portals are on DIFFERENT HOSTS at DIFFERENT paths. Until this
 * file existed, repLinkUrl hardcoded `/rep/enter/<token>` and the caller supplied the origin — so
 * an affiliate's emailed sign-in link was built with the affiliate host and the rep path, and
 * landed on a 404. scripts/affiliate-join-gate did exactly that and nothing noticed, because a
 * minted URL is a string and a string is always "produced successfully".
 *
 * A LINK NOBODY CAN FOLLOW IS WORSE THAN A LINK THAT WAS NEVER SENT. The affiliate has a code, an
 * email telling them to sign in, and no way in; the failure is entirely on our side and invisible
 * from it. So the path is DERIVED from the party rather than passed: mintRepLink reads party_type
 * and asks this file, and no caller is in a position to get it wrong.
 *
 * A LEAF — no imports at all, so a page, a gate, middleware-adjacent code and the email templates
 * can all read the same addresses without dragging the database into a bundle.
 */

/** The two parties that have a portal. Mirrors the PartyType enum; a third would be a decision. */
export const PORTAL_PARTIES = ['rep', 'affiliate'] as const;
export type PortalParty = (typeof PORTAL_PARTIES)[number];

type Portal = {
  /** Where an unauthenticated visitor is sent, and where "ask for a new link" points. */
  signIn: string;
  /** Where they land after signing in. */
  home: string;
  /** The emailed credential's landing page, given the raw token. */
  enter: (rawToken: string) => string;
  /** The public host, for copy that has to name it. Not used to build links — see the header. */
  host: string;
};

/**
 * ── THE AFFILIATE ADDRESSES ARE BARE, THE REP ADDRESSES ARE PREFIXED ────────────────────────────
 * Not an inconsistency anybody should tidy. The rep portal has lived at /rep/* since it shipped and
 * its links are in people's inboxes; the affiliate portal is new, and the owner's ruling of
 * 2026-10-31 is that the public affiliate addresses are bare — what a person types, and what a
 * printed poster can carry. The page FILES sit under /affiliate-portal so they keep 404ing on the
 * apex for free, and middleware rewrites the bare address onto them, exactly as /join already does.
 */
const PORTALS: Record<PortalParty, Portal> = {
  rep: {
    signIn: '/rep/login',
    home: '/rep',
    enter: (t) => `/rep/enter/${t}`,
    host: 'reps.greasedesk.com',
  },
  affiliate: {
    signIn: '/signin',
    home: '/dashboard',
    enter: (t) => `/enter/${t}`,
    host: 'affiliates.greasedesk.com',
  },
};

/**
 * FAILS CLOSED ON AN UNKNOWN PARTY. A party_type this file has never heard of gets no portal rather
 * than the rep's — defaulting would send one actor class's credential to another's front door, and
 * the whole point of the table is that the party decides the address.
 */
export function portalFor(partyType: string): Portal {
  const p = PORTALS[partyType as PortalParty];
  if (!p) throw new Error(`no portal for party_type '${partyType}' — add it to lib/party-portal deliberately, do not default it`);
  return p;
}

export const portalSignInPath = (partyType: string): string => portalFor(partyType).signIn;
export const portalHomePath = (partyType: string): string => portalFor(partyType).home;
export const portalEnterPath = (partyType: string, rawToken: string): string => portalFor(partyType).enter(rawToken);

/**
 * THE ABSOLUTE SIGN-IN ADDRESS, for copy that has to name it — an email, a printed card.
 *
 * ALWAYS THE PUBLIC HOST, never the request's. An emailed CREDENTIAL is built from the request
 * origin on purpose (middleware has already constrained the host, and dev serves every host on one
 * port); a sentence telling somebody where their page lives must say the real address, because they
 * will read it on a phone three weeks later.
 */
export const portalSignInUrl = (partyType: string): string => {
  const p = portalFor(partyType);
  return `https://${p.host}${p.signIn}`;
};

/** Every path a portal owns, for middleware's allow-list and for a gate that wants to sweep them. */
export function portalPaths(partyType: string): string[] {
  const p = portalFor(partyType);
  return [p.signIn, p.home, p.enter('')];
}
