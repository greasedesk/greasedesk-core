/**
 * File: lib/pwa-outbox.ts
 * Page-side outbox API (client-only). The DRAIN lives in the service worker (public/sw.js — one
 * implementation for Android Background Sync AND iOS foreground replay); this module only:
 * enqueues (IndexedDB FIRST, before any network — an OS-killed app loses nothing), reads the
 * queue for UI, triggers a drain, and manages retry/discard. The envelope is the one Slice 4's
 * time entries will ride: { id, kind, jobCardId, stage, slot, blob, contentType, createdAt,
 * attempts, lastError, state, nextAttemptAt }.
 */
const DB_NAME = 'gd-outbox';
const DB_VERSION = 1;

export type OutboxState = 'queued' | 'sending' | 'failed';
export type OutboxItem = {
  id: string; kind: 'photo' | 'vehicle'; jobCardId: string;
  stage?: string; slot?: string; blob?: Blob; contentType?: string;   // kind:'photo'
  payload?: { vin?: string; mileageIn?: number };                      // kind:'vehicle' — vehicle FACTS from the bay
  createdAt: number;
  attempts: number; lastError: string | null; state: OutboxState; nextAttemptAt: number | null; claimedAt: number | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function rw(fn: (s: IDBObjectStore) => void): Promise<void> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('outbox', 'readwrite');
    fn(t.objectStore('outbox'));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}
export async function outboxAll(): Promise<OutboxItem[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      req.onsuccess = () => resolve((req.result || []) as OutboxItem[]);
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}

/** Register the sync engine. Idempotent; call from every /m page. */
export async function ensureWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/m' }); } catch { /* engine optional — direct trigger still posts */ }
}

/** Kick the drain: Background Sync where it exists (survives the page), plus a direct message
 *  (immediate when online, and iOS's only path). */
export async function triggerDrain(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('sync' in reg) { try { await (reg as any).sync.register('outbox'); } catch { /* iOS */ } }
    reg.active?.postMessage({ type: 'drain' });
  } catch { /* next foreground trigger picks it up */ }
}

/** Capture → IDB FIRST → then the network is invited. Returns the idempotency id. */
export async function enqueuePhoto(args: { jobCardId: string; stage: string; blob: Blob; slot?: string }): Promise<string> {
  const item: OutboxItem = {
    id: crypto.randomUUID(), kind: 'photo', jobCardId: args.jobCardId, stage: args.stage, slot: args.slot ?? 'freeform',
    blob: args.blob, contentType: 'image/jpeg', createdAt: Date.now(),
    attempts: 0, lastError: null, state: 'queued', nextAttemptAt: 0, claimedAt: null,
  };
  await rw((s) => s.put(item)); // durably parked BEFORE any upload attempt
  triggerDrain();
  return item.id;
}

/** VIN / mileage from the bay — the SECOND kind on the same envelope (rides the same queue,
 *  same idempotency key, same drain). Writes through the EXISTING vehicle-facts path
 *  (/api/jobcard-details, partial + changed-fields-audited) — never a new endpoint. */
export async function enqueueVehicle(args: { jobCardId: string; vin?: string; mileageIn?: number }): Promise<string> {
  const payload: { vin?: string; mileageIn?: number } = {};
  if (args.vin !== undefined) payload.vin = args.vin;
  if (args.mileageIn !== undefined) payload.mileageIn = args.mileageIn;
  const item: OutboxItem = {
    id: crypto.randomUUID(), kind: 'vehicle', jobCardId: args.jobCardId, payload,
    createdAt: Date.now(), attempts: 0, lastError: null, state: 'queued', nextAttemptAt: 0, claimedAt: null,
  };
  await rw((s) => s.put(item)); // durably parked BEFORE any network
  triggerDrain();
  return item.id;
}

export async function retryItem(id: string): Promise<void> {
  const items = await outboxAll();
  const it = items.find((x) => x.id === id);
  if (!it) return;
  await rw((s) => s.put({ ...it, state: 'queued', attempts: 0, lastError: null, nextAttemptAt: 0, claimedAt: null }));
  triggerDrain();
}

/** Explicit, deliberate removal of a failed item — the only way an item vanishes unsent. */
export async function discardItem(id: string): Promise<void> {
  await rw((s) => s.delete(id));
  try { new BroadcastChannel('gd-outbox').postMessage({ type: 'outbox' }); } catch { /* count refreshes on next read */ }
}

/** Live queue counts for the always-visible badge. Returns an unsubscribe. */
export function subscribeOutbox(cb: (counts: { queued: number; failed: number }) => void): () => void {
  let bc: BroadcastChannel | null = null;
  const push = async () => {
    const items = await outboxAll();
    cb({ queued: items.filter((i) => i.state === 'queued' || i.state === 'sending').length, failed: items.filter((i) => i.state === 'failed').length });
  };
  push();
  try {
    bc = new BroadcastChannel('gd-outbox');
    bc.onmessage = () => push();
  } catch { /* no BC: counts refresh on page events below */ }
  const onWake = () => push();
  window.addEventListener('online', onWake);
  document.addEventListener('visibilitychange', onWake);
  return () => { bc?.close(); window.removeEventListener('online', onWake); document.removeEventListener('visibilitychange', onWake); };
}

/** Ask for durable storage; FALSE means the OS may evict queued photos under pressure — the UI
 *  must say so quietly rather than promise durability it doesn't have. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}
