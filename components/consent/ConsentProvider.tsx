/**
 * File: components/consent/ConsentProvider.tsx
 * The consent manager. Holds the per-category choice (seeded from the SSR-read cookie, so the banner
 * never flashes for a returning visitor), persists changes to the exempt gd_consent cookie + records a
 * versioned ConsentEvent, and — the Venus-ready part — runs a TRACKER REGISTRY: nothing in a category
 * fires until that category is consented, and a future tracker (GA, a pixel) registers here and is
 * injected only on its category's consent. Adding tracker N+1 is a registerTracker() call, not a rebuild.
 *
 * gd_ref (the only consent-gated writer today) is handled through here too: a ?ref= seen before the
 * visitor has chosen is held pending, and written iff/when functional consent is granted.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  POLICY_VERSION, isCurrent, writeConsentCookie, writeGdRef, clearGdRef,
  type ConsentRecord, type ConsentChoice, type ConsentCategory, CONSENTABLE,
} from '@/lib/consent';

type Tracker = { id: string; category: ConsentCategory; load: () => void };

type ConsentCtx = {
  record: ConsentRecord | null;      // null / stale-version = undecided → banner shows
  decided: boolean;
  region: string;
  consented: (c: ConsentCategory) => boolean;
  setChoice: (choice: ConsentChoice) => void;
  openManage: () => void;            // footer "Cookie settings" re-opens the banner in manage mode
  manageOpen: boolean;
  registerTracker: (t: Tracker) => void; // future trackers register here; injected on consent
  noteRef: (clean: string) => void;  // ?ref= capture routes through here (gated on functional consent)
};

const Ctx = createContext<ConsentCtx | null>(null);
export const useConsent = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConsent must be used within ConsentProvider');
  return c;
};

export function ConsentProvider({ initialRecord, region, children }: { initialRecord: ConsentRecord | null; region: string; children: React.ReactNode }) {
  const [record, setRecord] = useState<ConsentRecord | null>(isCurrent(initialRecord) ? initialRecord : null);
  const [manageOpen, setManageOpen] = useState(false);
  const trackers = useRef<Map<string, Tracker>>(new Map());
  const loaded = useRef<Set<string>>(new Set());
  const pendingRef = useRef<string | null>(null);

  const consented = useCallback((c: ConsentCategory) => !!record && record.choice[c] === true, [record]);

  /** Load any registered tracker whose category is now consented and hasn't loaded yet. Idempotent. */
  const runTrackers = useCallback(() => {
    if (!record) return;
    for (const t of trackers.current.values()) {
      if (record.choice[t.category] && !loaded.current.has(t.id)) {
        loaded.current.add(t.id);
        try { t.load(); } catch (e) { console.error('[consent] tracker load failed', t.id, e); }
      }
    }
  }, [record]);

  // On any consent change: fire eligible trackers, and flush/withdraw the pending gd_ref.
  useEffect(() => {
    runTrackers();
    if (consented('functional')) { if (pendingRef.current) { writeGdRef(pendingRef.current); pendingRef.current = null; } }
    else if (record) { clearGdRef(); } // functional refused/withdrawn → ensure no gd_ref lingers
  }, [record, runTrackers, consented]);

  const persist = useCallback((choice: ConsentChoice) => {
    const id = record?.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
    const rec: ConsentRecord = { v: POLICY_VERSION, id, ts: Date.now(), region, choice };
    writeConsentCookie(rec);
    setRecord(rec);
    setManageOpen(false);
    // Record the versioned event (best-effort; the cookie is the enforcement, the row is the audit).
    fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, v: rec.v, region, choice }) }).catch(() => {});
  }, [record, region]);

  const registerTracker = useCallback((t: Tracker) => { trackers.current.set(t.id, t); runTrackers(); }, [runTrackers]);

  const noteRef = useCallback((clean: string) => {
    if (!clean) return;
    if (consented('functional')) writeGdRef(clean); // already allowed → write now
    else if (!record) pendingRef.current = clean;   // undecided → hold until they choose (same page)
    // functional explicitly refused → do nothing (attribution intentionally lost)
  }, [consented, record]);

  const value = useMemo<ConsentCtx>(() => ({
    record, decided: !!record, region, consented, setChoice: persist,
    openManage: () => setManageOpen(true), manageOpen, registerTracker, noteRef,
  }), [record, region, consented, persist, manageOpen, registerTracker, noteRef]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── HOW A FUTURE TRACKER REGISTERS (the config-line-not-rebuild contract) ─────────────────────────
// e.g. a Google Analytics component mounted on the marketing site:
//
//   const { registerTracker } = useConsent();
//   useEffect(() => registerTracker({
//     id: 'ga4', category: 'analytics',
//     load: () => { /* inject gtag.js + init — runs ONLY once analytics is consented */ },
//   }), [registerTracker]);
//
// Nothing else changes: consent gating, the banner, the policy categories all already cover it.
export const CONSENT_CATEGORIES = CONSENTABLE;
