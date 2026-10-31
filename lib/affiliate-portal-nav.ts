/**
 * File: lib/affiliate-portal-nav.ts
 * THE AFFILIATE PORTAL'S MENU. One table, read by the shell, by the page that renders the sections,
 * and by a gate that checks every item in it leads somewhere.
 *
 * A LEAF — no imports — for the reason lib/affiliate-portal-copy is one: a constant pulled from a
 * module that reaches the database ships Prisma to the browser, and this list is rendered in the
 * browser on every portal page.
 *
 * ── SECTIONS, NOT PAGES, AND THE REASON IS LATENCY ──────────────────────────────────────────────
 * The owner left the choice open ("its own page or anchor, your call"). affiliatePortalData is a
 * NINE-DEEP serial chain of queries — rep, settings, terms, groups, entries, payee, two documents,
 * the acceptance row — and functions are pinned to lhr1 beside Neon in eu-west-2 precisely because
 * query depth is latency. Six pages would each pay that chain again on every click of the menu, so
 * one fetch serves the whole portal and the menu switches which section is shown.
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
 */

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

export type PortalLink = { key: string; label: string; href: string };

/** Pages, not sections — see the header. */
export const PORTAL_LINKS: readonly PortalLink[] = [
  { key: 'terms', label: 'Terms', href: '/terms' },
];

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
