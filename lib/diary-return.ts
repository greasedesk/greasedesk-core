/**
 * File: lib/diary-return.ts
 * THE one place that decides where "back to the diary" lands.
 *
 * The diary anchors on ?date=YYYY-MM-DD and SILENTLY FALLS BACK TO TODAY when that param is absent
 * or malformed (see the gssp regex in pages/admin/diary.tsx). So any return link that omits the
 * date doesn't fail loudly — it quietly dumps the user on today, days or months from the job they
 * were looking at. Two controls built their own URL with different rules and different bugs; this
 * gives them one rule.
 *
 * Resolution, in order:
 *   1. the date the user was VIEWING (?date= carried in when they opened the card)
 *   2. the date the CARD SITS ON (its booking start) — right day even when the user arrived from
 *      a list, an invoice, or a fresh tab with no diary context
 *   3. omit the param — the diary then falls back to today, which is the honest answer when the
 *      card has never been placed and there is no day to return to
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string, or null. Accepts a date-only string or a full ISO timestamp. */
function toYmd(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const head = v.slice(0, 10);
  return YMD.test(head) ? head : null;
}

export type DiaryReturnParams = {
  /** ?site= — falls back to the card's own site so the link never lands on another location. */
  siteId?: string | string[] | null;
  /** ?view= as the user had it (day/week/month); defaults to week, matching the diary's own default. */
  view?: string | string[] | null;
  /** ?date= the user was viewing when they opened the card. */
  viewedDate?: string | string[] | null;
  /** The card's booking start (ISO) — the day the job actually sits on. */
  cardStartAt?: string | null;
};

export function diaryReturnHref(p: DiaryReturnParams): string {
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const site = typeof first(p.siteId) === 'string' ? (first(p.siteId) as string) : '';
  const viewRaw = typeof first(p.view) === 'string' ? (first(p.view) as string) : '';
  const view = ['day', 'week', 'month'].includes(viewRaw) ? viewRaw : 'week';

  const date = toYmd(first(p.viewedDate)) ?? toYmd(p.cardStartAt);

  const qs = new URLSearchParams();
  if (site) qs.set('site', site);
  qs.set('view', view);
  if (date) qs.set('date', date); // omitted (not blank) when unknown — a blank param means "today" anyway
  return `/admin/diary?${qs.toString()}`;
}
