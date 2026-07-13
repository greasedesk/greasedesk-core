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
  // RULING 2026-07-13 (supersedes Wi-Fi-preferred, after a walkaround rotted in IndexedDB over
  // eight hours): a video uploads the INSTANT it can — no Wi-Fi hold, no waiting. Every second
  // in the queue is risk; the queue exists for the bay with no bars, not as a resting place.
  // Photos still always send first, and jump between video parts.
  return true;
}

// Persisting progress doubles as a claim HEARTBEAT: a multi-minute video upload must not look
// stale (2-min window) to a concurrent drain while it is demonstrably alive.
async function persistItem(db, item) { item.claimedAt = Date.now(); await tx(db, 'readwrite', (s) => s.put(item)); }

// Rich failure detail (ruling 2026-07-13: never swallow an upload failure into a bare string).
// Every video-step error carries { step, status, code, body } — persisted into lastError as JSON
// AND beaconed to /api/pwa/upload-error, which writes it to the card's audit trail so the
// verbatim failure is readable server-side, not trapped in one handset's IndexedDB.
function stepError(step, status, code, body, terminal) {
  const detail = { step, status: status || 0, code: code || null, body: (body || '').slice(0, 300) };
  return Object.assign(new Error(JSON.stringify(detail)), { status: status || 0, detail, code, terminal: !!terminal });
}

// WebKit's dangling-blob-handle signature ("The object can not be found here."). Bytes that
// can't be read are NOT a transient failure — no backoff will bring them back (ruling
// 2026-07-13: terminal on FIRST occurrence, honest message, no hour-long retries).
const DANGLING_RE = /can\s?not be found/i;
const unrecoverable = (msg) => stepError('body-unreadable', 0, 'unrecoverable', msg, true);

function beaconUploadError(item, detail) {
  try {
    fetch('/api/pwa/upload-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ jobCardId: item.jobCardId, photoId: item.id, kind: item.kind, attempts: (item.attempts || 0) + 1, detail }),
    }).catch(function () { /* telemetry is best-effort — never blocks the queue */ });
  } catch (e) { /* ditto */ }
}

async function multipartCall(item, body) {
  const res = await fetch('/api/photos/multipart', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(Object.assign({
      jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, contentType: item.contentType, photoId: item.id,
    }, body)),
  });
  if (!res.ok) {
    // ':cors' code survives the throw — the queue bar renders setup states differently.
    let code = null; let text = '';
    try { text = await res.text(); const b = JSON.parse(text); if (b && b.code) code = b.code; } catch (e) { /* not json */ }
    throw stepError('multipart-' + body.action, res.status, code, text);
  }
  return res.json();
}

/** Resumable multipart send for ONE video. Progress (uploadId + per-part etags) is persisted to
 *  IndexedDB after EVERY part — an app kill costs at most one 5 MiB part, reconciled against R2
 *  (ListParts) on resume rather than trusting local state. checkInterrupt() is called between
 *  parts: new photos/vehicle facts jump the queue mid-video — a VIN photo never sits behind
 *  28MB on one bar. */
// A small video takes THE PHOTO PATH (ruling 2026-07-13): whole body, single presigned PUT, no
// slicing, no ETag reads, no parts — the path proven by every photo from this same handset,
// worker and bucket. Multipart is for genuinely large files only. Crucially this never touches
// WebKit's broken JS blob-read layer: fetch streams the body itself (the same pipeline that
// plays the video), so legacy IDB blobs that arrayBuffer() refuses still send.
const SINGLE_PUT_MAX = 20 * 1024 * 1024;

async function sendVideoSinglePut(item) {
  // Legacy single-blob item: PROBE the stored bytes before spending a presign — a dangling
  // handle here means no retry can ever succeed (first-occurrence terminal, honest message).
  if (!item.parts) {
    if (!item.blob) throw unrecoverable('no stored bytes');
    try { await item.blob.slice(0, 65536, '').arrayBuffer(); }
    catch (e) { throw unrecoverable('probe: ' + String((e && e.message) || e)); }
  }
  const pres = await fetch('/api/photos/presign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, contentType: item.contentType, photoId: item.id }),
  });
  if (!pres.ok) {
    let text = ''; try { text = await pres.text(); } catch (e) { /* none */ }
    throw stepError('presign', pres.status, null, text);
  }
  const { key, uploadUrl } = await pres.json();
  // parts (ArrayBuffers) recompose in memory; a legacy blob is handed to fetch UNREAD.
  const body = item.parts ? new Blob(item.parts, { type: item.contentType }) : item.blob;
  let put;
  try {
    put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': item.contentType }, body });
  } catch (e) {
    throw stepError('single-put-network', 0, null, String((e && e.message) || 'fetch failed'));
  }
  if (!put.ok) {
    let text = ''; try { text = await put.text(); } catch (e) { /* opaque */ }
    throw stepError('single-put', put.status >= 500 ? put.status : 500, null, text); // expired presign → transient, re-presign next pass
  }
  const commit = await fetch('/api/photos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ jobCardId: item.jobCardId, stage: item.stage, slot: item.slot, photoId: item.id, key, durationSeconds: item.durationSeconds }),
  });
  if (!commit.ok) {
    let text = ''; try { text = await commit.text(); } catch (e) { /* none */ }
    throw stepError('commit', commit.status, null, text);
  }
}

async function sendVideoItem(db, item, checkInterrupt) {
  const partBytes = (p) => (p && typeof p.byteLength === 'number') ? p.byteLength : (p ? p.size : 0);
  const totalVideoBytes = item.parts ? item.parts.reduce((s, p) => s + partBytes(p), 0) : (item.blob ? item.blob.size : 0);
  // THE FORK: small videos go down the proven photo path; multipart is reserved for the >20MB
  // walkaround on a busier scene.
  if (totalVideoBytes <= SINGLE_PUT_MAX) return sendVideoSinglePut(item);

  // ── multipart (>20MB only) ──
  // Parts are ArrayBuffers stored inline in IDB (immune to the WebKit blob-read failure).
  // A legacy oversize single-blob item is rescued by materialising the whole blob once and
  // slicing the buffer in memory; if even that read fails, the beacon names it.
  let wholeBuf = null;
  if (!item.parts) {
    if (!item.blob) throw unrecoverable('no stored bytes');
    try {
      wholeBuf = await item.blob.arrayBuffer();
      if (wholeBuf.byteLength !== item.blob.size) throw new Error('short read: got ' + wholeBuf.byteLength + ' of ' + item.blob.size);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Dangling handle = the bytes are gone to every retry → terminal NOW, not after 8 backoffs.
      throw stepError('blob-whole-read', 0, DANGLING_RE.test(msg) ? 'unrecoverable' : null,
        'size=' + item.blob.size + ' err=' + msg, DANGLING_RE.test(msg));
    }
  }
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
  // 3. Send what's missing (uniform PART_SIZE — an R2 requirement, not a preference).
  const partSize = item.partSize || (5 * 1024 * 1024);
  const total = item.parts ? item.parts.length : Math.ceil(totalVideoBytes / partSize);
  if (total > 40) throw Object.assign(new Error('video-too-large'), { terminal: true });
  const missing = [];
  for (let n = 1; n <= total; n++) if (!item.etags || !item.etags[String(n)]) missing.push(n);
  if (missing.length) {
    const presigned = await multipartCall(item, { action: 'parts', uploadId: item.uploadId, partNumbers: missing });
    const urlByPart = {};
    for (const u of presigned.urls) urlByPart[u.partNumber] = u.url;
    for (const n of missing) {
      // Slice with an EMPTY type: fetch must not add a Content-Type header the part signature never saw.
      // Part bytes WITHOUT ever touching WebKit's blob-read layer on stored data: ArrayBuffer
      // parts are used directly (IDB keeps them inline); a transitional Blob part (the brief
      // Blob[] deploy) or legacy whole-blob slice goes through a guarded read that beacons as
      // its own step — never masquerading as a network failure.
      let buf;
      try {
        if (item.parts) {
          const pb = item.parts[n - 1];
          buf = (pb && typeof pb.byteLength === 'number') ? pb : await pb.arrayBuffer();
        } else {
          buf = wholeBuf.slice((n - 1) * partSize, Math.min(n * partSize, totalVideoBytes));
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        throw stepError('part-read', 0, DANGLING_RE.test(msg) ? 'unrecoverable' : null,
          'part=' + n + ' err=' + msg, DANGLING_RE.test(msg));
      }
      let put;
      try {
        put = await fetch(urlByPart[n], { method: 'PUT', body: buf });
      } catch (e) {
        // A CORS/preflight-blocked PUT surfaces as an opaque TypeError in fetch — name the layer
        // rather than letting it collapse into a generic transient. Body-read failures can't
        // land here any more (the buffer is already in memory).
        throw stepError('part-put-network', 0, null, 'part=' + n + ' ' + String((e && e.message) || 'fetch failed'));
      }
      if (!put.ok) {
        let text = ''; try { text = await put.text(); } catch (e2) { /* opaque */ }
        // R2 4xx here = expired presign → transient, re-presign next pass
        throw stepError('part-put', put.status >= 500 ? put.status : 500, null, text);
      }
      // THE true "ETag not exposed" signal (post-mortem 2026-07-13): the part PUT succeeded but
      // the browser can't read the ETag response header — observed where it actually occurs,
      // not inferred from bucket introspection. code 'cors' is what the queue bar renders as
      // the admin-setup message. Retryable, never terminal — fixing the bucket unsticks it.
      const etag = put.headers.get('ETag');
      if (!etag) throw stepError('part-etag', 503, 'cors', 'part stored but ETag header not readable from JS');
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
  if (!commit.ok) {
    let text = ''; try { text = await commit.text(); } catch (e) { /* none */ }
    throw stepError('commit', commit.status, null, text);
  }
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
      // Video failures carry structured detail (stepError) — beacon it to the audit trail so the
      // verbatim failure is readable server-side, never trapped in this handset's IndexedDB.
      if (item.kind === 'video' && e && e.detail) beaconUploadError(item, e.detail);
      const updated = {
        ...item, // multipart progress (uploadId/etags) survives — a failed pass resumes, never restarts
        state: failedOut ? 'failed' : 'queued',
        claimedAt: null,
        attempts,
        lastError: String((e && e.message) || 'error'),
        nextAttemptAt: failedOut ? null : Date.now() + Math.min(30000 * Math.pow(2, attempts), 3600000),
      };
      try {
        await tx(db, 'readwrite', (s) => s.put(updated));
      } catch (persistErr) {
        // THE SILENT-LOOP KILLER (post-mortem 2026-07-13): re-putting the item structured-clones
        // its blob, and WebKit can refuse to clone a dangling-handle blob — the attempts counter
        // then never persists, the stale-claim release requeues the OLD row, and the cap can
        // never fire. When the full row won't save, persist a SLIMMED terminal row (bytes
        // dropped — they were unreadable anyway): the tile shows the honest failed state,
        // discard works, and nothing loops forever.
        const slim = Object.assign({}, updated);
        delete slim.blob; delete slim.parts;
        slim.state = 'failed'; slim.nextAttemptAt = null;
        slim.lastError = JSON.stringify({ step: 'persist', status: 0, code: 'unrecoverable', body: 'item state could not be re-saved (blob clone refused): ' + String((persistErr && persistErr.message) || persistErr) });
        try { await tx(db, 'readwrite', (s) => s.put(slim)); } catch (e2) { /* row stands; stale release re-queues it */ }
      }
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
// waitUntil is LOAD-BEARING here (post-mortem 2026-07-13, the "Load failed" beacon): the message
// event is iOS's ONLY drain path (no Background Sync), and without it WebKit reaps the worker
// while the drain is mid-flight — aborting any in-flight part PUT. Photos squeezed through on
// speed; a 5 MiB video part never did. ExtendableMessageEvent.waitUntil holds the worker open
// for the drain's whole promise.
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'drain') e.waitUntil(drain()); });
