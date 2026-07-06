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
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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

/** Delete an object (best-effort; the DB row is the source of truth). */
export async function deleteObject(key: string): Promise<void> {
  const c = client(); if (!c) return;
  try { await c.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })); }
  catch (e: any) { console.error('[r2] deleteObject error', e?.name || e?.message); }
}
