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
  id: string; kind: 'photo' | 'vehicle' | 'video'; jobCardId: string;
  stage?: string; slot?: string; blob?: Blob; contentType?: string;   // kind:'photo' | 'video'
  payload?: { vin?: string; mileageIn?: number };                      // kind:'vehicle' — vehicle FACTS from the bay
  durationSeconds?: number | null;                                     // kind:'video'
  // kind:'video' multipart progress — persisted per part so an app kill costs ≤ one 5 MiB part:
  uploadId?: string | null; partSize?: number; etags?: Record<string, string>; key?: string | null;
  sendNow?: boolean; // user overrode the Wi-Fi hold — sticks until sent
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

/** Walkaround video — the THIRD kind on the same envelope (same queue, same idempotency id, same
 *  drain). Sent via the resumable multipart lane in sw.js; held for Wi-Fi where the platform can
 *  tell us (Android), or for an explicit "Send now" where it can't (iOS). Never blocks photos. */
export async function enqueueVideo(args: { jobCardId: string; stage: string; blob: Blob; contentType: string; durationSeconds?: number | null }): Promise<string> {
  const item: OutboxItem = {
    id: crypto.randomUUID(), kind: 'video', jobCardId: args.jobCardId, stage: args.stage, slot: 'walkaround',
    blob: args.blob, contentType: args.contentType, durationSeconds: args.durationSeconds ?? null,
    uploadId: null, etags: {}, key: null, sendNow: false,
    createdAt: Date.now(), attempts: 0, lastError: null, state: 'queued', nextAttemptAt: 0, claimedAt: null,
  };
  await rw((s) => s.put(item)); // durably parked BEFORE any network
  triggerDrain();
  return item.id;
}

// Queue-control writes must be VISIBLE immediately (never-silent rule) — the SW only broadcasts
// when a drain touches an item, which offline can be never. Every control pings the channel
// itself so subscribers re-read IndexedDB at once.
function pingOutbox(): void {
  try { new BroadcastChannel('gd-outbox').postMessage({ type: 'outbox' }); } catch { /* counts refresh on next read */ }
}

/** Override the Wi-Fi hold on every waiting video (the honest "Send now" tap). Sticks per item
 *  until sent, so a transient failure on mobile data keeps retrying rather than re-holding. */
export async function sendVideosNow(): Promise<void> {
  const items = await outboxAll();
  for (const it of items) {
    if (it.kind === 'video' && it.state !== 'failed' && !it.sendNow) {
      await rw((s) => s.put({ ...it, sendNow: true, nextAttemptAt: 0 }));
    }
  }
  pingOutbox();
  triggerDrain();
}

export async function retryItem(id: string): Promise<void> {
  const items = await outboxAll();
  const it = items.find((x) => x.id === id);
  if (!it) return;
  await rw((s) => s.put({ ...it, state: 'queued', attempts: 0, lastError: null, nextAttemptAt: 0, claimedAt: null }));
  pingOutbox();
  triggerDrain();
}

/** Explicit, deliberate removal of a failed item — the only way an item vanishes unsent.
 *  A discarded video with an in-flight multipart upload gets a best-effort abort (frees the
 *  invisible billed parts now; the bucket's 7-day abort rule is the backstop either way). */
export async function discardItem(id: string): Promise<void> {
  const items = await outboxAll();
  const it = items.find((x) => x.id === id);
  await rw((s) => s.delete(id));
  if (it?.kind === 'video' && it.uploadId) {
    fetch('/api/photos/multipart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ action: 'abort', jobCardId: it.jobCardId, stage: it.stage, slot: it.slot, contentType: it.contentType, photoId: it.id, uploadId: it.uploadId }),
    }).catch(() => { /* lifecycle rule reaps it */ });
  }
  try { new BroadcastChannel('gd-outbox').postMessage({ type: 'outbox' }); } catch { /* count refreshes on next read */ }
}

export type OutboxCounts = {
  queued: number; failed: number; videos: number;
  /** Something is actively mid-send right now. */
  sending: boolean;
  /** Earliest scheduled retry among transiently-failed items (ms epoch), or null. The bar turns
   *  this into "Couldn't send — retrying in Ns" — a tap must NEVER look like nothing happened. */
  nextRetryAt: number | null;
  /** A video hit the storage-CORS setup gate (server code 'cors') — a SETUP state to name
   *  honestly, not a network failure to count down from. */
  corsBlocked: boolean;
};

/** Live queue state for the always-visible badge. Returns an unsubscribe. Videos are counted
 *  on their OWN line (a 28MB walkaround and a VIN photo are different promises to the mechanic). */
export function subscribeOutbox(cb: (counts: OutboxCounts) => void): () => void {
  let bc: BroadcastChannel | null = null;
  const push = async () => {
    const items = await outboxAll();
    const active = (i: OutboxItem) => i.state === 'queued' || i.state === 'sending';
    const retryAts = items
      .filter((i) => i.state === 'queued' && (i.attempts || 0) > 0 && (i.nextAttemptAt || 0) > Date.now())
      .map((i) => i.nextAttemptAt as number);
    cb({
      queued: items.filter((i) => active(i) && i.kind !== 'video').length,
      failed: items.filter((i) => i.state === 'failed').length,
      videos: items.filter((i) => active(i) && i.kind === 'video').length,
      sending: items.some((i) => i.state === 'sending'),
      nextRetryAt: retryAts.length ? Math.min(...retryAts) : null,
      corsBlocked: items.some((i) => i.kind === 'video' && i.state !== 'failed' && String(i.lastError || '').includes(':cors')),
    });
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
