/**
 * File: lib/diary-day.ts
 * THE diary-day reads — ONE chokepoint shared by the desktop diary gssp and the phone's
 * /api/pwa/day, so the office and the floor can never see different days. Same where-clauses,
 * same selects, same service-label derivation; the consumers differ only in PROJECTION (the
 * phone endpoint projects the money fields OUT — absent, not hidden).
 */
import { prisma } from '@/lib/db';

/** Booked cards overlapping [rangeStart, rangeEnd) at a site — the diary's booking query, verbatim.
 *  NOTE: the select carries the money fields the DESKTOP diary needs for its (financeVisibility-
 *  gated) totals; a money-free consumer must project them out server-side. */
export function fetchDayBookings(siteId: string, rangeStart: Date, rangeEnd: Date): Promise<any[]> {
  return prisma.jobCard.findMany({
    where: { site_id: siteId, resource_id: { not: null }, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
    select: {
      id: true, resource_id: true, start_at: true, end_at: true, booking_duration_minutes: true, status: true, vat_rate: true, is_comeback: true, held_on_lift: true,
      resource: { select: { name: true, colour: true } }, vehicle: { select: { registration: true } }, customer: { select: { name: true } },
      items: { select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true }, orderBy: { created_at: 'asc' } },
    },
  }) as Promise<any[]>;
}

/** Day notes overlapping the range — the diary's note query, verbatim. */
export function fetchDayNotes(siteId: string, rangeStart: Date, rangeEnd: Date): Promise<any[]> {
  return prisma.diaryNote.findMany({
    where: { site_id: siteId, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
    select: { id: true, title: true, resource_id: true, colour: true, start_at: true, end_at: true },
  }) as Promise<any[]>;
}

/** The diary's block-label derivation, verbatim: fixed-line TITLES first (the Title model),
 *  else every line's first line; summary = "First +N". */
export function serviceLabels(items: Array<{ item_type: string; description: string | null }>): { labels: string[]; summary: string } {
  const firstLine = (s: string) => (s || '').split('\n')[0].trim();
  const fixedNames = items.filter((it) => it.item_type === 'fixed').map((it) => firstLine(it.description ?? '')).filter(Boolean);
  const labels = fixedNames.length ? fixedNames : items.map((it) => firstLine(it.description ?? '')).filter(Boolean);
  const summary = labels.length ? (labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0]) : '';
  return { labels, summary };
}
