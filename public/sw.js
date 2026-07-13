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
 * kind:'video' adds multipart progress { uploadId, partSize, etags, key, sendNow } — see THE
 * VIDEO LANE below: resumable 5 MiB parts, photos always sent first, Wi-Fi-preferred hold.
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
  const active = (i) => i.state === 'queued' || i.state === 'sending';
  const queued = items.filter((i) => active(i) && i.kind !== 'video').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  const videos = items.filter((i) => active(i) && i.kind === 'video').length;
  try { new BroadcastChannel('gd-outbox').postMessage({ type: 'outbox', queued, failed, videos }); } catch (e) { /* old browser */ }
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

// ── THE VIDEO LANE ────────────────────────────────────────────────────────────────────────────
// Wi-Fi-preferred hold: where the platform can tell us the transport (Android Chrome exposes
// navigator.connection.type), a video auto-sends only on wifi/ethernet; where it can't (iOS has
// no transport signal at all), it waits for the user's explicit "Send now" — an honest hold,
// never a silent 28MB on one bar. sendNow (set by that tap) overrides the hold and STICKS until
// the item is sent, so a transient failure on mobile data keeps retrying rather than re-holding.
function videoMaySend(item) {
  if (item.sendNow) return true;
  const conn = self.navigator && self.navigator.connection;
  if (conn && typeof conn.type === 'string') return conn.type === 'wifi' || conn.type === 'ethernet';
  return false; // no signal (iOS) → hold for the tap
}

// Persisting progress doubles as a claim HEARTBEAT: a multi-minute video upload must not look
// stale (2-min window) to a concurrent drain while it is demonstrably alive.
async function persistItem(db, item) { item.claimedAt = Date.now(); await tx(db, 'readwrite', (s) => s.put(item)); }

async function multipartCall(item, body) {
  const res = await fetch('/api/photos/multipart', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(Object.assign({
      jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, contentType: item.contentType, photoId: item.id,
    }, body)),
  });
  if (!res.ok) {
    // Carry the server's machine-readable code (e.g. ':cors') into lastError — the queue bar
    // renders setup states differently from network states, so the code must survive the throw.
    let code = '';
    try { const b = await res.json(); if (b && b.code) code = ':' + b.code; } catch (e) { /* no body */ }
    throw Object.assign(new Error('multipart-' + body.action + ':' + res.status + code), { status: res.status });
  }
  return res.json();
}

/** Resumable multipart send for ONE video. Progress (uploadId + per-part etags) is persisted to
 *  IndexedDB after EVERY part — an app kill costs at most one 5 MiB part, reconciled against R2
 *  (ListParts) on resume rather than trusting local state. checkInterrupt() is called between
 *  parts: new photos/vehicle facts jump the queue mid-video — a VIN photo never sits behind
 *  28MB on one bar. */
async function sendVideoItem(db, item, checkInterrupt) {
  // 1. Open (or reopen) the multipart upload.
  if (!item.uploadId) {
    const created = await multipartCall(item, { action: 'create' });
    item.uploadId = created.uploadId; item.partSize = created.partSize; item.key = created.key; item.etags = {};
    await persistItem(db, item);
  } else {
    // 2. Resume: R2 is the source of truth for which parts survived.
    let status;
    try {
      status = await multipartCall(item, { action: 'status', uploadId: item.uploadId });
    } catch (e) {
      if (e && e.status === 410) { // upload expired/aborted (e.g. the 7-day reaper) → restart clean, not terminal
        item.uploadId = null; item.etags = {}; item.key = null;
        await persistItem(db, item);
        throw Object.assign(new Error('multipart-restart'), { status: 500 });
      }
      throw e;
    }
    item.key = status.key;
    item.etags = {};
    for (const p of status.parts) item.etags[String(p.partNumber)] = p.etag;
    await persistItem(db, item);
  }
  // 3. Slice + send what's missing (uniform PART_SIZE — an R2 requirement, not a preference).
  const partSize = item.partSize || (5 * 1024 * 1024);
  const total = Math.ceil(item.blob.size / partSize);
  if (total > 40) throw Object.assign(new Error('video-too-large'), { terminal: true });
  const missing = [];
  for (let n = 1; n <= total; n++) if (!item.etags || !item.etags[String(n)]) missing.push(n);
  if (missing.length) {
    const presigned = await multipartCall(item, { action: 'parts', uploadId: item.uploadId, partNumbers: missing });
    const urlByPart = {};
    for (const u of presigned.urls) urlByPart[u.partNumber] = u.url;
    for (const n of missing) {
      // Slice with an EMPTY type: fetch must not add a Content-Type header the part signature never saw.
      const chunk = item.blob.slice((n - 1) * partSize, Math.min(n * partSize, item.blob.size), '');
      const put = await fetch(urlByPart[n], { method: 'PUT', body: chunk });
      if (!put.ok) throw Object.assign(new Error('part:' + put.status), { status: put.status >= 500 ? put.status : 500 }); // R2 4xx = expired presign → re-presign next pass
      // THE true "ETag not exposed" signal (post-mortem 2026-07-13): the part PUT succeeded but
      // the browser can't read the ETag response header — observed where it actually occurs,
      // not inferred from bucket introspection. ':cors' is the token the queue bar renders as
      // the admin-setup message. Retryable, never terminal — fixing the bucket unsticks it.
      const etag = put.headers.get('ETag');
      if (!etag) throw Object.assign(new Error('part-etag:cors'), { status: 503 });
      item.etags = item.etags || {}; item.etags[String(n)] = etag;
      await persistItem(db, item); // ≤ one part ever repeats
      if (checkInterrupt) await checkInterrupt(); // photos enqueued mid-video go NOW
    }
  }
  // 4. Assemble, then the normal idempotent commit — a video is a JobCardPhoto row like any other.
  const parts = [];
  for (const [n, etag] of Object.entries(item.etags)) parts.push({ partNumber: Number(n), etag });
  const done = await multipartCall(item, { action: 'complete', uploadId: item.uploadId, parts });
  const commit = await fetch('/api/photos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, photoId: item.id, key: done.key, durationSeconds: item.durationSeconds }),
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
  // One item: claim (compare-and-set) → send by kind → delete on success / taxonomy on failure.
  // Returns true if the item was sent. Only the drain that flips queued→sending sends an item —
  // a concurrent drain sees 'sending' and skips.
  async function processItem(item) {
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
    if (!claimed) return false;
    item.state = 'sending';
    await broadcastNow(db);
    let sent = false;
    try {
      if (item.kind === 'video') {
        // Between video parts, anything small that arrived jumps the queue (never recurses into
        // videos — the filter excludes them).
        await sendVideoItem(db, item, async () => {
          const small = (await getAll(db)).filter((i) => i.kind !== 'video' && i.state === 'queued' && (i.nextAttemptAt || 0) <= Date.now())
            .sort((a, b) => a.createdAt - b.createdAt);
          for (const s of small) await processItem(s);
        });
      } else {
        await sendItem(item);
      }
      await tx(db, 'readwrite', (s) => s.delete(item.id)); // sent: the server row is the receipt
      sent = true;
    } catch (e) {
      const status = e && e.status;
      const terminal = (e && e.terminal) || TERMINAL_STATUSES.includes(status);
      const attempts = (item.attempts || 0) + 1;
      const failedOut = terminal || attempts >= MAX_ATTEMPTS;
      const updated = {
        ...item, // multipart progress (uploadId/etags) survives — a failed pass resumes, never restarts
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
    return sent;
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    // ORDER: every photo/vehicle item first (oldest first), THEN videos — the small, urgent
    // stuff never queues behind 28MB. Held videos (no Wi-Fi, no Send-now) are skipped without
    // burning an attempt: waiting for a network is not a failure.
    const items = (await getAll(db)).filter((i) => i.state === 'queued' && (i.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => (a.kind === 'video' ? 1 : 0) - (b.kind === 'video' ? 1 : 0) || a.createdAt - b.createdAt)
      .filter((i) => i.kind !== 'video' || videoMaySend(i));
    for (const item of items) {
      if (await processItem(item)) progressed = true;
    }
  }
  // Videos still HELD for Wi-Fi: re-arm Background Sync so the next connectivity change (e.g.
  // joining the workshop Wi-Fi) refires the drain even with the app closed. One-shot syncs
  // unregister on success — without this a held video would wait for the next app open.
  const leftover = await getAll(db);
  if (leftover.some((i) => i.kind === 'video' && i.state === 'queued') && self.registration && self.registration.sync) {
    try { await self.registration.sync.register('outbox'); } catch (e) { /* foreground triggers cover it */ }
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
