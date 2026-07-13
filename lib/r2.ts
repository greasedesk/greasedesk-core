/**
 * File: lib/r2.ts
 * THE one place the private R2 media bucket is reached — SERVER-SIDE ONLY (credentials never touch the
 * client). Cloudflare R2 is S3-compatible. Browsers upload/read via PRESIGNED URLs (bytes go straight
 * browser↔R2, never through the function). Bucket stays PRIVATE — customer vehicle photos.
 *
 * Env: R2_ACCOUNT_ID, R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. The endpoint
 * is read directly (not derived). Best-effort: no creds → null (feature dormant, never crashes).
 *
 * Key layout (tenant-partitioned): {groupId}/{jobCardId}/{stage}/{slot}/{photoId}.{ext} (jpg|png|mp4|webm|mov)
 */
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, ListPartsCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function r2Configured(): boolean {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME
    && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

let _client: S3Client | null = null;
function client(): S3Client | null {
  if (!r2Configured()) {
    console.warn('[r2] not configured — env presence:', {
      ACCOUNT_ID: !!process.env.R2_ACCOUNT_ID, ENDPOINT: !!process.env.R2_ENDPOINT, BUCKET_NAME: !!process.env.R2_BUCKET_NAME,
      ACCESS_KEY_ID: !!process.env.R2_ACCESS_KEY_ID, SECRET_ACCESS_KEY: !!process.env.R2_SECRET_ACCESS_KEY,
    });
    return null;
  }
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT as string,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID as string, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string },
    });
  }
  return _client;
}

const bucket = () => process.env.R2_BUCKET_NAME as string;

/** Tenant-partitioned object key. Extension follows the (server-validated) content type: jpg/png/mp4/webm/mov. */
export function photoKey(groupId: string, jobCardId: string, stage: string, slot: string, photoId: string, ext = 'jpg'): string {
  const safe = (s: string) => (s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe(groupId)}/${safe(jobCardId)}/${safe(stage)}/${safe(slot)}/${photoId}.${safe(ext)}`;
}

/** Presigned PUT for a browser upload (5 min). Returns null if R2 isn't configured. */
export async function presignPut(key: string, contentType = 'image/jpeg'): Promise<string | null> {
  const c = client(); if (!c) return null;
  try {
    return await getSignedUrl(c, new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: 300 });
  } catch (e: any) { console.error('[r2] presignPut error', e?.name || e?.message); return null; }
}

/** Presigned GET for display (15 min). */
export async function presignGet(key: string): Promise<string | null> {
  const c = client(); if (!c) return null;
  try {
    return await getSignedUrl(c, new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: 900 });
  } catch (e: any) { console.error('[r2] presignGet error', e?.name || e?.message); return null; }
}

/** Object size in bytes via HeadObject (best-effort; null when unavailable). Used to write the
 *  verified landed size into the audit trail on video commits. */
export async function headObjectSize(key: string): Promise<number | null> {
  const c = client(); if (!c) return null;
  try {
    const r = await c.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return r.ContentLength ?? null;
  } catch (e: any) { console.error('[r2] headObjectSize error', e?.name || e?.message); return null; }
}

/** Delete an object (best-effort; the DB row is the source of truth). */
export async function deleteObject(key: string): Promise<void> {
  const c = client(); if (!c) return;
  try { await c.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })); }
  catch (e: any) { console.error('[r2] deleteObject error', e?.name || e?.message); }
}

// ── Multipart (the resumable video lane) ──────────────────────────────────────────────────────
// R2 constraints built around here: parts must be UNIFORM size (except the last) — the client
// slices at exactly PART_SIZE; and the browser can only assemble CompleteMultipartUpload if the
// bucket CORS EXPOSES the ETag header (detected in the browser at the point of failure — see
// NOTE below). Incomplete uploads are reaped by the bucket's 7-day abort lifecycle rule (that
// rule type acts on incomplete uploads ONLY — it cannot touch a completed object).

export const PART_SIZE = 5 * 1024 * 1024; // R2 minimum part size; uniform by construction
export const MAX_PARTS = 40; // 200 MiB ceiling — a 90s/2.5Mbps walkaround is ~6 parts

// NOTE (post-mortem 2026-07-13): there is deliberately NO GetBucketCors pre-check here. The
// app's R2 token is object-scoped — bucket introspection returns 403, which a guard can only
// misread as "CORS not configured" (it did, and blocked every upload against a correct bucket).
// The ETag-exposure requirement is detected at the point of actual failure, in the browser
// (sw.js: part PUT succeeded but ETag header unreadable → the code:'cors' setup message).

export async function createMultipartUpload(key: string, contentType: string): Promise<string | null> {
  const c = client(); if (!c) return null;
  try {
    const res = await c.send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }));
    return res.UploadId ?? null;
  } catch (e: any) { console.error('[r2] createMultipart error', e?.name || e?.message); return null; }
}

/** Presigned PUT for ONE part (15 min — a 5 MiB part on one bar can take a while; the drain
 *  re-requests URLs for whatever is still missing on every pass, so expiry only costs a retry). */
export async function presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string | null> {
  const c = client(); if (!c) return null;
  try {
    return await getSignedUrl(c, new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 900 });
  } catch (e: any) { console.error('[r2] presignPart error', e?.name || e?.message); return null; }
}

/** Parts R2 already holds for this upload — the RESUME source of truth (never trust client-side
 *  progress alone across an app kill). null = the uploadId no longer exists (expired/aborted). */
export async function listUploadedParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string }[] | null> {
  const c = client(); if (!c) return null;
  try {
    const res = await c.send(new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
    return (res.Parts || []).map((p) => ({ partNumber: p.PartNumber as number, etag: String(p.ETag || '') }));
  } catch (e: any) {
    if (e?.name === 'NoSuchUpload') return null;
    console.error('[r2] listParts error', e?.name || e?.message);
    throw e;
  }
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<boolean> {
  const c = client(); if (!c) return false;
  try {
    await c.send(new CompleteMultipartUploadCommand({
      Bucket: bucket(), Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.slice().sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }));
    return true;
  } catch (e: any) { console.error('[r2] completeMultipart error', e?.name || e?.message); return false; }
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  const c = client(); if (!c) return;
  try { await c.send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId })); }
  catch (e: any) { if (e?.name !== 'NoSuchUpload') console.error('[r2] abortMultipart error', e?.name || e?.message); }
}
