/**
 * File: components/pwa/OutboxStatus.tsx
 * The ALWAYS-VISIBLE queue state (every /m screen, not just the card that took the photos).
 * CORE DISCIPLINE — NEVER SILENT: every tap on a queue control produces a visible state change.
 *   · "Send now" → "Sending…" appears IMMEDIATELY (optimistic, then confirmed by the queue).
 *   · Transient failure → "Couldn't send — retrying in Ns", ticking live; when it hits zero the
 *     bar ITSELF fires the drain (while the app is open, the bar is the retry timer — otherwise
 *     the countdown would be a lie: Background Sync only re-fires on connectivity change).
 *   · The storage-CORS setup gate (server code 'cors') → named honestly as an admin setup state,
 *     never presented as a mysterious network failure during tenant onboarding.
 *   · Terminal failure → the failed count, with retry/discard on the job's own tiles.
 * Videos send IMMEDIATELY when online (ruling 2026-07-13 — the Wi-Fi hold is gone; a video
 * rotted in IndexedDB waiting for it). Send now remains as the backoff-reset for failures.
 * Also carries the storage-persistence honesty line when the OS refused durable storage.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { ensureWorker, requestPersistence, sendVideosNow, subscribeOutbox, triggerDrain, discardItem, OutboxCounts } from '@/lib/pwa-outbox';
import { cacheGet } from '@/lib/pwa-idb';

const EMPTY: OutboxCounts = { queued: 0, failed: 0, videos: 0, sending: false, nextRetryAt: null, corsBlocked: false, failedItems: [] };

export default function OutboxStatus() {
  const { t } = useTranslation('pwa');
  const [counts, setCounts] = useState<OutboxCounts>(EMPTY);
  const [persisted, setPersisted] = useState(true); // assume ok until told otherwise — the line is for a REFUSAL
  const [tapped, setTapped] = useState(false); // optimistic "Sending…" between the tap and the queue's first broadcast
  const [retryIn, setRetryIn] = useState<number | null>(null); // live countdown seconds
  const [regByCard, setRegByCard] = useState<Record<string, string>>({}); // resolved reg per jobCardId (envelope-label fallback)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve the reg for FAILED items whose envelope predates the `label` field (the envelope is a
  // cache; old items lack it). Card-first: the cached job text, then a best-effort fetch. The card
  // LINK always works regardless — a null reg never makes the item unreachable, only unnamed.
  useEffect(() => {
    const need = counts.failedItems.filter((f) => !f.label && f.jobCardId && !regByCard[f.jobCardId]);
    if (!need.length) return;
    let live = true;
    (async () => {
      const found: Record<string, string> = {};
      for (const f of need) {
        try {
          const cached = await cacheGet<any>(`job:${f.jobCardId}`);
          let reg = cached?.value?.vehicle?.registration;
          if (!reg) {
            const res = await fetch(`/api/pwa/job/${encodeURIComponent(f.jobCardId)}`, { cache: 'no-store' });
            if (res.ok) reg = (await res.json())?.vehicle?.registration;
          }
          if (reg) found[f.jobCardId] = reg;
        } catch { /* offline / gone — the link still works, name stays generic */ }
      }
      if (live && Object.keys(found).length) setRegByCard((m) => ({ ...m, ...found }));
    })();
    return () => { live = false; };
  }, [counts.failedItems, regByCard]);

  function discardFailed(id: string) {
    if (!window.confirm(t('outboxDiscardConfirm'))) return;
    discardItem(id); // broadcasts → the banner updates itself
  }

  useEffect(() => {
    ensureWorker();
    requestPersistence().then(setPersisted);
    const un = subscribeOutbox((c) => {
      setCounts(c);
      if (c.sending) setTapped(false); // the queue confirmed the send — the real state takes over
    });
    triggerDrain(); // app-open replay (iOS's path; harmless elsewhere)
    // Joining Wi-Fi while the app is open = a held video's moment — drain immediately.
    const conn = (navigator as any)?.connection;
    const onChange = () => triggerDrain();
    conn?.addEventListener?.('change', onChange);
    return () => { conn?.removeEventListener?.('change', onChange); un(); if (tapTimer.current) clearTimeout(tapTimer.current); };
  }, []);

  // The retry countdown ticks every second; at zero the bar fires the drain (see file header).
  useEffect(() => {
    if (!counts.nextRetryAt) { setRetryIn(null); return; }
    const tick = () => {
      const s = Math.ceil(((counts.nextRetryAt as number) - Date.now()) / 1000);
      if (s <= 0) { setRetryIn(null); triggerDrain(); return; }
      setRetryIn(s);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [counts.nextRetryAt]);

  function onSendNow() {
    setTapped(true); // the tap is visible BEFORE anything succeeds or fails
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => setTapped(false), 8000); // never a stuck "Sending…" if the drain can't even start
    sendVideosNow();
  }

  const showSending = tapped || counts.sending;
  if (counts.queued === 0 && counts.failed === 0 && counts.videos === 0 && persisted) return null;
  return (
    <div className="px-4 py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5" style={{ background: '#1C3257', color: '#C7D2E1' }}>
      {counts.queued > 0 && <span className="font-semibold" style={{ color: '#FFFFFF' }}>{t('outboxWaiting', { count: counts.queued })}</span>}
      {counts.videos > 0 && (
        <span className="font-semibold inline-flex items-center gap-2" style={{ color: '#FFFFFF' }}>
          {showSending ? t('outboxSending') : t('videoWaiting', { count: counts.videos })}
          {!showSending && (
            <button onClick={onSendNow} className="underline font-semibold min-h-[28px]" style={{ color: '#8AB4F8' }}>
              {t('videoSendNow')}
            </button>
          )}
        </span>
      )}
      {/* Setup state beats countdown: "retrying in 30s" against an unconfigured bucket is noise. */}
      {counts.corsBlocked ? (
        <span style={{ color: '#FCD34D' }}>{t('videoSetupNeeded')}</span>
      ) : (retryIn != null && !showSending) ? (
        <span style={{ color: '#FCD34D' }}>{t('outboxRetryIn', { s: retryIn })}</span>
      ) : null}
      {/* FAILED items name their car (card-resolved when the envelope lacks it), LINK to the card,
          AND carry their OWN discard — so NO item is ever unreachable, even a ghost from an older
          schema with no tile to tap. This is the rule the outbox was built on. */}
      {counts.failedItems.map((f) => {
        const reg = f.label || (f.jobCardId && regByCard[f.jobCardId]) || t('outboxFailedUnknownReg');
        return (
          <span key={f.id} className="inline-flex items-center gap-2">
            <a href={`/m/job/${f.jobCardId}`} className="font-semibold underline" style={{ color: '#FCA5A5' }}>
              {t('outboxFailedNamed', { reg })}
            </a>
            <button onClick={() => discardFailed(f.id)} className="underline min-h-[28px]" style={{ color: '#8AB4F8' }}>
              {t('discard')}
            </button>
          </span>
        );
      })}
      {!persisted && <span>{t('storageNote')}</span>}
    </div>
  );
}
