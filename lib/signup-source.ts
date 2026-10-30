/**
 * File: lib/signup-source.ts
 * HOW A GARAGE SAYS IT FOUND US — the one list, and the one clean.
 *
 * ── A LEAF MODULE, WITH NO IMPORTS ─────────────────────────────────────────────────────────────
 * /register is a public page that ships to the browser and renders the options from here, while
 * the API route validates against the same constant. A module-scope import of anything that
 * reaches lib/db from a page ships Prisma to the browser and kills every bit of client JavaScript
 * on it (it has happened twice), so this imports nothing, for ever.
 *
 * ── THE QUESTION IS OPTIONAL, AND "NOT ANSWERED" IS NOT AN ANSWER ──────────────────────────────
 * Three states, not two: a value from the list below, the free text behind "Something else", or
 * NULL — not asked, skipped, or signed up before the question existed. The Engine Room says "not
 * recorded" for NULL rather than "direct", because this is a self-reported marketing answer and
 * the absence of one says nothing about how somebody arrived. Who referred them is a different
 * question with a different source (Group.signup_ref and the frozen terms) and real money on it.
 *
 * ── THE VALUES ARE STORED, THE LABELS ARE COPY ─────────────────────────────────────────────────
 * `value` goes in the column and never changes; `label` is the sentence on the form and will be
 * reworded. heardAboutLabel therefore falls back to the stored value for anything it does not
 * recognise, so a row answered under older copy still shows what was answered instead of
 * disappearing from the screen. This is also why the column carries no CHECK constraint: a
 * wording change must not be a constraining migration.
 */

export type HeardAboutOption = { value: string; label: string };

/** The value that opens the free-text box. Named, because three files test for it. */
export const HEARD_ABOUT_OTHER = 'other';

/** THE LIST (owner, 2026-10-30). Order is the order on the form. */
export const HEARD_ABOUT_OPTIONS: HeardAboutOption[] = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'google', label: 'Google' },
  { value: 'rep_visit', label: 'A GreaseDesk rep visited' },
  { value: 'supplier_van', label: 'A supplier or tool van' },
  { value: 'another_garage', label: 'Another garage' },
  { value: HEARD_ABOUT_OTHER, label: 'Something else' },
];

const BY_VALUE = new Map(HEARD_ABOUT_OPTIONS.map((o) => [o.value, o.label]));

/** How long a free-text answer may be. Long enough for a sentence, short enough not to be a story. */
export const HEARD_ABOUT_OTHER_MAX = 200;
/** How much of a campaign parameter we keep. Real ones are short; a long one is somebody's bug. */
export const UTM_MAX = 120;

/**
 * STRIP WHAT CANNOT BE STORED, keep what was typed.
 *
 * Control characters go — and the NUL byte specifically, because Postgres refuses a string
 * containing one with error 22021 and the failure surfaces as a crashed signup rather than as a
 * bad field. Everything else a person can type survives: this is free text and an answer with an
 * apostrophe or an ampersand in it is a normal answer, not an attack. Escaping belongs to the
 * surfaces that render or export it, not here.
 */
function cleanText(raw: unknown, max: number): string | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).trim();
  return stripped || null; // blank is NULL: an empty string is a typed answer of nothing
}

/**
 * THE ANSWER, OR NULL. Anything not on the list is refused rather than stored — the column has no
 * CHECK, so this function IS the constraint, and a client posting `heardAbout: "<script>"` must
 * leave the column NULL rather than put its own string in our marketing figures.
 */
export function normaliseHeardAbout(raw: unknown): string | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase();
  return BY_VALUE.has(v) ? v : null;
}

/** The free text, kept ONLY when "Something else" was the answer. */
export function normaliseHeardAboutOther(heardAbout: string | null, raw: unknown): string | null {
  if (heardAbout !== HEARD_ABOUT_OTHER) return null;
  return cleanText(raw, HEARD_ABOUT_OTHER_MAX);
}

/** What to show for a stored value: its current label, or the value itself if the copy has moved on. */
export function heardAboutLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return BY_VALUE.get(value) ?? value;
}

// ── THE CAMPAIGN PARAMETERS ────────────────────────────────────────────────────────────────────
export type UtmParts = { source: string | null; medium: string | null; campaign: string | null };
export const UTM_EMPTY: UtmParts = { source: null, medium: null, campaign: null };

/** The three query keys, in the order they are stored. */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;

/** Clean the three, from anything query-shaped. All-null when there was no campaign on the URL. */
export function readUtmFromQuery(q: Record<string, unknown> | null | undefined): UtmParts {
  const g = (k: string) => cleanText(q?.[k], UTM_MAX);
  return { source: g('utm_source'), medium: g('utm_medium'), campaign: g('utm_campaign') };
}

/** Clean the three from a posted object (the shape /register sends). */
export function normaliseUtm(raw: unknown): UtmParts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    source: cleanText(o.source, UTM_MAX),
    medium: cleanText(o.medium, UTM_MAX),
    campaign: cleanText(o.campaign, UTM_MAX),
  };
}

/** Did the URL carry a campaign at all? One place, so "nothing to store" is decided once. */
export function hasUtm(u: UtmParts | null | undefined): boolean {
  return !!u && (!!u.source || !!u.medium || !!u.campaign);
}
