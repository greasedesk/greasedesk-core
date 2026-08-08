/**
 * File: components/jobcard/JobCardAudit.tsx
 * Audit trail foot pane. Reads events captured by lib/audit.ts (status/stage/booking/invoice). It
 * fills GOING FORWARD only — nothing was written before this slice shipped, so older cards start
 * empty; that's stated in the empty/preface copy so it never reads as "nothing happened".
 * i18n-native (event labels via jobcard:audit.<action>, with a raw fallback), mobile-first.
 */
import React from 'react';
import { useTranslation } from 'next-i18next';

export type AuditEvent = {
  id: string; action: string; actor: string | null; at: string;
  /**
   * PROVENANCE, IN WORDS. Server-computed (lib/jobcard-page-data) from the audit diff, because the
   * distinction that matters here is not in the action name. Since acceptance was unified into one
   * chokepoint, a customer's own click and a garage-recorded one both write `quote.accepted`, and
   * this view used to carry no diff at all — so the only difference on screen was whether a staff
   * name happened to appear. That is an absence, not a statement: a reader could not tell "the
   * customer did this" from "we don't know who did". Null on every event that isn't an acceptance.
   */
  note?: string | null;
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); return `${d}d ago`;
}

export default function JobCardAudit({ events }: { events: AuditEvent[] }) {
  const { t } = useTranslation('jobcard');
  const label = (action: string) => {
    const key = `audit.${action}`;
    const translated = t(key);
    return translated === key ? action : translated; // fall back to the raw key if unmapped
  };
  return (
    <div className="bg-surface border border-line rounded-xl p-5 mt-8">
      <h2 className="text-lg font-semibold text-ink mb-1">{t('audit.title')}</h2>
      <p className="text-xs text-muted mb-3">{t('audit.preface')}</p>
      {events.length === 0 ? (
        <p className="text-muted text-sm">{t('audit.empty')}</p>
      ) : (
        <ol className="space-y-2">
          {events.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-3 text-sm border-b border-line last:border-0 pb-2">
              <span className="text-ink">
                {label(e.action)}
                {e.note && <span className="block text-xs text-muted mt-0.5" data-testid="audit-note">{e.note}</span>}
              </span>
              <span className="text-muted whitespace-nowrap text-xs">
                {e.actor ? `${e.actor} · ` : ''}{relTime(e.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
