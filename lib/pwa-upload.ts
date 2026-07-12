/**
 * File: lib/pwa-upload.ts
 * THE phone photo upload pipe (client-only): presign → PUT to R2 → idempotent commit. The SAME
 * existing endpoints as the desktop — no new permission surface, no bytes through the server.
 * The photoId is generated AT CAPTURE by the caller and passed to presign, so any replay
 * re-presigns to the SAME R2 key and re-commits the same row (server upserts — 200 first time or
 * fifth). Step 6's outbox calls exactly this function for queued entries: the queue changes WHERE
 * the blob waits, never what happens to it.
 */
export type UploadArgs = { jobCardId: string; stage: 'intake' | 'injob' | 'completion'; photoId: string; blob: Blob };

export async function uploadPhoto({ jobCardId, stage, photoId, blob }: UploadArgs): Promise<void> {
  const pres = await fetch('/api/photos/presign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobCardId, stage, slot: 'freeform', contentType: 'image/jpeg', photoId }),
  });
  if (!pres.ok) throw new Error(`presign:${pres.status}`);
  const { key, uploadUrl } = await pres.json();
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (!put.ok) throw new Error(`put:${put.status}`);
  const commit = await fetch('/api/photos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobCardId, stage, slot: 'freeform', photoId, key }),
  });
  if (!commit.ok) throw new Error(`commit:${commit.status}`);
}
