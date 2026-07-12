/**
 * File: lib/pwa-idb.ts
 * THE phone surface's IndexedDB (client-only, no dependency). One database, two stores:
 *   cache  — last-known server JSON per key (cache-first rendering: My Day paints instantly
 *            from here, then revalidates; a mechanic under a car never waits on a spinner)
 *   outbox — the offline queue (build step 6): photo blobs keyed by the idempotency id
 *            generated at capture. Declared NOW so the schema never needs a version bump
 *            between steps.
 */
const DB_NAME = 'gd-outbox';
const DB_VERSION = 1;

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

export async function cacheGet<T = unknown>(key: string): Promise<{ value: T; at: number } | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('cache', 'readonly');
      const req = tx.objectStore('cache').get(key);
      req.onsuccess = () => resolve(req.result ? { value: req.result.value as T, at: req.result.at as number } : null);
      req.onerror = () => resolve(null); // cache is best-effort — a read failure is a cold start, never an error state
    });
  } catch { return null; }
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('cache', 'readwrite');
      tx.objectStore('cache').put({ key, value, at: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* best-effort */ }
}
