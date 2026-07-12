/**
 * File: public/sw.js
 * THE outbox drain engine — the ONE implementation for both platforms (PWA build step 6).
 * Android/Chromium fires it via Background Sync (tag 'outbox'); iOS has no Background Sync, so
 * the page posts {type:'drain'} on app-open / visibilitychange / online — SAME function either way.
 * No fetch handler: this worker is a sync engine, not a cache (page caching is IndexedDB's job).
 *
 * THE ENVELOPE (Slice 4's time entries ride this unchanged — kind:'time' alters nothing here
 * except which endpoint sends an item): { id (idempotency key, minted at capture), kind,
 * jobCardId, stage, slot, blob, contentType, createdAt, attempts, lastError, state, nextAttemptAt }.
 *
 * RE-ENTRANCY: Background Sync and a foreground drain CAN fire together. Two guards:
 *   1. Web Locks ('gd-outbox-drain', ifAvailable) — the second drain simply doesn't start;
 *   2. per-item 'sending' claims with a stale-claim reset (a drain killed mid-item releases
 *      after 2 minutes) — so even without Locks support, an item is never double-PUT by
 *      concurrent drains. The server upsert makes a double-COMMIT harmless; these guards are
 *      what make a double-DRAIN not happen.
 *
 * TERMINAL vs TRANSIENT (get this wrong and the queue never empties):
 *   5xx / network error / timeout → transient: exponential backoff (30s·2^attempts, cap 1h).
 *   401 → transient with backoff (session lapsed; a login fixes it — never terminal).
 *   400 (forgery guard) / 403 (access lost) / 404 (card gone) → TERMINAL: state 'failed',
 *   never retried automatically. Visible in the UI with explicit retry/discard.
 *   Transient attempts cap at 8 → 'failed' (visible), never a silent forever-spin.
 */
/* eslint-disable no-restricted-globals */
const DB_NAME = 'gd-outbox';
const DB_VERSION = 1;
const MAX_ATTEMPTS = 8;
const STALE_CLAIM_MS = 2 * 60 * 1000;
const TERMINAL_STATUSES = [400, 403, 404];

function openDb() {
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
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('outbox', mode);
    const out = fn(t.objectStore('outbox'));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
function getAll(db) {
  return new Promise((resolve) => {
    const t = db.transaction('outbox', 'readonly');
    const req = t.objectStore('outbox').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

function broadcast(items) {
  const queued = items.filter((i) => i.state === 'queued' || i.state === 'sending').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  try { new BroadcastChannel('gd-outbox').postMessage({ type: 'outbox', queued, failed }); } catch (e) { /* old browser */ }
}
async function broadcastNow(db) { broadcast(await getAll(db)); }

/** One item through the pipe, by kind. photo: presign (same client id → same R2 key) → PUT →
 *  idempotent commit. vehicle: the existing vehicle-facts path (partial update, changed-fields
 *  audited; naturally idempotent — the same value twice is a no-op the second time). */
async function sendItem(item) {
  if (item.kind === 'vehicle') {
    const res = await fetch('/api/jobcard-details', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ jobCardId: item.jobCardId, vehicle: item.payload || {} }),
    });
    if (!res.ok) throw Object.assign(new Error('vehicle:' + res.status), { status: res.status });
    return;
  }
  if (item.kind !== 'photo') throw Object.assign(new Error('unknown-kind'), { terminal: true }); // future kinds add a sender here
  const pres = await fetch('/api/photos/presign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, contentType: item.contentType, photoId: item.id }),
  });
  if (!pres.ok) throw Object.assign(new Error('presign:' + pres.status), { status: pres.status });
  const { key, uploadUrl } = await pres.json();
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': item.contentType }, body: item.blob });
  if (!put.ok) throw Object.assign(new Error('put:' + put.status), { status: put.status >= 500 ? put.status : 500 }); // R2 4xx here = expired presign → transient, re-presigns next pass
  const commit = await fetch('/api/photos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, photoId: item.id, key }),
  });
  if (!commit.ok) throw Object.assign(new Error('commit:' + commit.status), { status: commit.status });
}

async function drainInner() {
  const db = await openDb();
  const now = Date.now();
  // Stale-claim reset: a drain killed mid-item left 'sending' rows — release them.
  const all = await getAll(db);
  for (const it of all) {
    if (it.state === 'sending' && (now - (it.claimedAt || 0)) > STALE_CLAIM_MS) {
      it.state = 'queued'; it.claimedAt = null;
      await tx(db, 'readwrite', (s) => s.put(it));
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    const items = (await getAll(db)).filter((i) => i.state === 'queued' && (i.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      // CLAIM (compare-and-set inside one readwrite tx): only the drain that flips
      // queued→sending sends this item — the concurrent drain sees 'sending' and skips.
      const claimed = await new Promise((resolve) => {
        const t = db.transaction('outbox', 'readwrite');
        const store = t.objectStore('outbox');
        const g = store.get(item.id);
        g.onsuccess = () => {
          const cur = g.result;
          if (!cur || cur.state !== 'queued') { resolve(false); return; }
          cur.state = 'sending'; cur.claimedAt = Date.now();
          store.put(cur); resolve(true);
        };
        g.onerror = () => resolve(false);
      });
      if (!claimed) continue;
      await broadcastNow(db);
      try {
        await sendItem(item);
        await tx(db, 'readwrite', (s) => s.delete(item.id)); // sent: the server row is the receipt
        progressed = true;
      } catch (e) {
        const status = e && e.status;
        const terminal = (e && e.terminal) || TERMINAL_STATUSES.includes(status);
        const attempts = (item.attempts || 0) + 1;
        const failedOut = terminal || attempts >= MAX_ATTEMPTS;
        const updated = {
          ...item,
          state: failedOut ? 'failed' : 'queued',
          claimedAt: null,
          attempts,
          lastError: String((e && e.message) || 'error'),
          nextAttemptAt: failedOut ? null : Date.now() + Math.min(30000 * Math.pow(2, attempts), 3600000),
        };
        await tx(db, 'readwrite', (s) => s.put(updated));
        // Ask Chromium to wake us again when connectivity returns (no-op elsewhere).
        if (!failedOut && self.registration && self.registration.sync) {
          try { await self.registration.sync.register('outbox'); } catch (e2) { /* foreground triggers cover it */ }
        }
      }
      await broadcastNow(db);
    }
  }
  await broadcastNow(db);
}

function drain() {
  // Single-flight: Web Locks where available; the per-item claim protocol guards the rest.
  if (self.navigator && self.navigator.locks && self.navigator.locks.request) {
    return self.navigator.locks.request('gd-outbox-drain', { ifAvailable: true }, (lock) => (lock ? drainInner() : undefined));
  }
  return drainInner();
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('sync', (e) => { if (e.tag === 'outbox') e.waitUntil(drain()); });
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'drain') drain(); });
