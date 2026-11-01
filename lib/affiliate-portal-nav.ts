/**
 * File: lib/affiliate-portal-nav.ts
 * THE AFFILIATE PORTAL'S MENU. One table, read by the shell, by the page that renders the sections,
 * and by a gate that checks every item in it leads somewhere.
 *
 * A LEAF — it imports lib/party-portal and nothing else, for the reason lib/affiliate-portal-copy
 * imports nothing: a constant pulled from a module that reaches the database ships Prisma to the
 * browser, and this list is rendered in the browser on every portal page. party-portal is itself a
 * zero-import leaf, and it is imported rather than copied because the dashboard's address must have
 * ONE home — see sectionHref below, which exists because a menu item was addressing the wrong page.
 *
 * ── SECTIONS, NOT PAGES, AND THE REASON IS LATENCY ──────────────────────────────────────────────
 * The owner left the choice open ("its own page or anchor, your call"). affiliatePortalData is a
 * SEVEN-DEEP serial chain of queries — rep, settings, terms, groups, entries, payee, the video
 * document — and functions are pinned to lhr1 beside Neon in eu-west-2 precisely because query
 * depth is latency. Six pages would each pay that chain again on every click of the menu, so one
 * fetch serves the whole portal and the menu switches which section is shown.
 *
 * It was NINE until 2026-11-01: the terms document and the acceptance row went with the Terms page,
 * which is its own read. The number is written here because it is the reason for the design, and a
 * reason carrying a stale number is a reason nobody can check.
 *
 * THE HASH IS THE SOURCE OF TRUTH, not a piece of component state the hash is kept in step with.
 * The menu items are real links to `#key`; the page listens for the hash changing and renders the
 * section it names. So a pasted address opens on the right section, Back walks the sections, and
 * there is exactly one thing to be wrong rather than two that can disagree.
 *
 * THE POSTER AND THE TERMS ARE NOT SECTIONS. Both are real pages: the poster owns a paper size and
 * is printed, and the terms are a published legal document that is also read by people who are not
 * signed in. They appear in the menu as links, in their own list, because "goes somewhere else" and
 * "shows a different part of this page" are different things to a person reading a menu.
 *
 * ── TERMS NOW OPENS INSIDE THE PORTAL (owner, 2026-11-01) ───────────────────────────────────────
 * It pointed at /terms, the PUBLIC page — so a signed-in affiliate clicking an item in their own
 * menu left their portal, lost the menu, and landed on the page we show to someone deciding whether
 * to join. It said nothing about what they had accepted, which is the one thing a signed-in person
 * is asking of that screen.
 *
 * So the menu's Terms goes to the portal's own page, which carries the agreement AND the version
 * and date they accepted. The public page is unchanged and still lives at /terms for the people it
 * was written for — two audiences, two pages, and neither pretending to be the other.
 */

import { portalHomePath } from '@/lib/party-portal';

export type PortalSectionKey = 'overview' | 'share' | 'posts' | 'garages' | 'earnings' | 'payment-details';

export type PortalSection = {
  key: PortalSectionKey;
  /** The menu's words. The portal is English-only for launch — see the i18n debt on the board. */
  label: string;
  icon: string;
};

/**
 * IN THE ORDER SOMEBODY ACTUALLY USES THEM: what this is, how to share it, what to post, who came
 * in, what we owe, where to send it. Payment details sits last because it is done once.
 */
export const PORTAL_SECTIONS: readonly PortalSection[] = [
  { key: 'overview', label: 'Overview', icon: '🏠' },
  { key: 'share', label: 'Share', icon: '🔗' },
  { key: 'posts', label: 'Posts & videos', icon: '📣' },
  { key: 'garages', label: 'My garages', icon: '🔧' },
  { key: 'earnings', label: 'Earnings', icon: '💷' },
  { key: 'payment-details', label: 'Payment details', icon: '🏦' },
];

/** What a visitor with no hash sees, and what an unrecognised hash falls back to. */
export const PORTAL_DEFAULT_SECTION: PortalSectionKey = 'overview';

export type PortalLinkKey = 'terms';
export type PortalLink = { key: PortalLinkKey; label: string; href: string };

/**
 * THE PORTAL'S OWN TERMS PAGE, and the ONE home for its address.
 *
 * middleware imports this constant rather than spelling the path again — the same arrangement
 * lib/party-portal exists for, and for the reason recorded there: an address written in two places
 * gets changed in one of them, and the half that is wrong is a page nobody can reach.
 *
 * NOT /terms, which belongs to the public page on this same host. Two documents at one address
 * would mean deciding WHO is asking in middleware, from a cookie, on every request — and a page
 * that serves two audiences inherits one of them, which is how a 404 came to tell the public site's
 * visitors they were still signed in.
 */
export const PORTAL_TERMS_PATH = '/my-terms';

/** Pages, not sections — see the header. */
export const PORTAL_LINKS: readonly PortalLink[] = [
  { key: 'terms', label: 'Terms', href: PORTAL_TERMS_PATH },
];

/**
 * WHAT THE MENU CAN BE SHOWING: one of the dashboard's sections, or one of the pages. The shell
 * takes this rather than a section key, so the Terms page can mark its own menu item as the current
 * one — an item that highlights on six screens and goes dead on the seventh reads as a bug.
 */
export type PortalNavKey = PortalSectionKey | PortalLinkKey;

/** Is this nav key one of the dashboard's sections? Enumerated from the table, never a name test. */
export const isSectionKey = (k: unknown): k is PortalSectionKey =>
  PORTAL_SECTIONS.some((s) => s.key === k);

/**
 * ── WHERE A MENU ITEM POINTS, GIVEN WHERE YOU ARE STANDING (owner, 2026-11-01, live bug) ────────
 * The shell rendered a bare `#key` wherever it was mounted. On the dashboard that is right: the six
 * sections are panes in ONE document and the hash is what selects them. On the Terms page — the
 * first page to mount this menu that is not the dashboard — a bare hash addresses THAT page, so
 * every section item silently did nothing: no pane to show, no listener to fire, and a menu that
 * looks alive and is dead.
 *
 * The rule therefore depends on where the menu is, which is exactly what `active` already says. So
 * it lives here as a function of both rather than as a conditional inside the component: a gate can
 * ask it about every combination without a browser, and there is one place to be wrong.
 *
 * NOT "always absolute", which would also have fixed the bug. A full navigation per click would
 * re-pay affiliatePortalData's whole chain to move between panes of a page already open — the
 * latency this menu is sections-not-pages for. Absolute off the dashboard, bare on it.
 */
export function sectionHref(key: PortalSectionKey, from: PortalNavKey): string {
  return isSectionKey(from) ? `#${key}` : `${portalHomePath('affiliate')}#${key}`;
}

/**
 * FAILS TO THE DEFAULT RATHER THAN THROWING. The input is whatever is in somebody's address bar,
 * which is not a thing to crash a signed-in page over — a stale link from an older menu should open
 * the portal, not break it.
 */
export function sectionFromHash(hash: string): PortalSectionKey {
  // TRIMMED BEFORE THE SIGIL IS STRIPPED, not after: ' #earnings' kept its hash through a `^#`
  // that no longer matched, and fell through to the default. window.location.hash never carries
  // whitespace, so nothing on the portal could reach it — which is exactly why it needed a clause.
  const want = String(hash ?? '').trim().replace(/^#/, '').trim().toLowerCase();
  const hit = PORTAL_SECTIONS.find((s) => s.key === want);
  return hit ? hit.key : PORTAL_DEFAULT_SECTION;
}
