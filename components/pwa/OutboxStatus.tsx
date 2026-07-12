/**
 * File: components/pwa/OutboxStatus.tsx
 * The ALWAYS-VISIBLE queue state (every /m screen, not just the card that took the photos):
 * "N waiting to send" + a failed count when present — a mechanic who sees zero knows they're
 * done; the queue is never silent. Also carries the storage-persistence honesty line: if the OS
 * refused durable storage, say quietly that photos live on this phone until sent.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { ensureWorker, requestPersistence, subscribeOutbox, triggerDrain } from '@/lib/pwa-outbox';

export default function OutboxStatus() {
  const { t } = useTranslation('pwa');
  const [counts, setCounts] = useState({ queued: 0, failed: 0 });
  const [persisted, setPersisted] = useState(true); // assume ok until told otherwise — the line is for a REFUSAL

  useEffect(() => {
    ensureWorker();
    requestPersistence().then(setPersisted);
    const un = subscribeOutbox(setCounts);
    triggerDrain(); // app-open replay (iOS's path; harmless elsewhere)
    return un;
  }, []);

  if (counts.queued === 0 && counts.failed === 0 && persisted) return null;
  return (
    <div className="px-4 py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5" style={{ background: '#1C3257', color: '#C7D2E1' }}>
      {counts.queued > 0 && <span className="font-semibold" style={{ color: '#FFFFFF' }}>{t('outboxWaiting', { count: counts.queued })}</span>}
      {counts.failed > 0 && <span className="font-semibold" style={{ color: '#FCA5A5' }}>{t('outboxFailed', { count: counts.failed })}</span>}
      {!persisted && <span>{t('storageNote')}</span>}
    </div>
  );
}
