/**
 * File: pages/api/cron/r2-diag.ts
 * TEMPORARY DIAGNOSTIC (ruling 2026-07-13: report the raw GetBucketCors response verbatim, and
 * verify the first real multipart video object). DELETE after the CORS false-negative post-mortem
 * — this route exists for one report. CRON_SECRET Bearer guard (same as confirm-paid); runs
 * server-side where the R2 credentials live. READ-ONLY against the bucket.
 *   GET ?op=cors        → raw GetBucketCors outcome: rules or the full error (name/code/status/message)
 *   GET ?op=head&key=…  → HeadObject: size/type/etag for a key (verify the walkaround landed)
 *   GET ?op=mpcreate    → open a multipart upload on a zz-diag/ probe key + presign part 1
 *   GET ?op=mpcomplete&key&uploadId&etag → complete the probe upload with part 1
 *   GET ?op=mpabort&key&uploadId / ?op=del&key → clean the probe up
 * The mp*/del ops are hard-restricted to keys under zz-diag/ — structurally incapable of
 * touching a real object.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  S3Client, GetBucketCorsCommand, HeadObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function client(): S3Client | null {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto', endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: 'Not authorised.' });
  }
  const c = client();
  if (!c) return res.status(503).json({ message: 'R2 not configured.' });
  const bucket = process.env.R2_BUCKET_NAME as string;
  const op = String(req.query.op || '');

  if (op === 'cors') {
    try {
      const r = await c.send(new GetBucketCorsCommand({ Bucket: bucket }));
      return res.status(200).json({ outcome: 'success', rules: r.CORSRules ?? [] });
    } catch (e: any) {
      // VERBATIM — the whole point of this route. Nothing swallowed.
      return res.status(200).json({
        outcome: 'error',
        name: e?.name ?? null,
        code: e?.Code ?? e?.code ?? null,
        httpStatusCode: e?.$metadata?.httpStatusCode ?? null,
        message: e?.message ?? null,
        fault: e?.$fault ?? null,
      });
    }
  }

  if (op === 'head') {
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ message: 'key required.' });
    try {
      const r = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return res.status(200).json({ outcome: 'success', key, size: r.ContentLength ?? null, contentType: r.ContentType ?? null, etag: r.ETag ?? null, lastModified: r.LastModified ?? null });
    } catch (e: any) {
      return res.status(200).json({ outcome: 'error', key, name: e?.name ?? null, httpStatusCode: e?.$metadata?.httpStatusCode ?? null, message: e?.message ?? null });
    }
  }

  // ── multipart probe (zz-diag/ keys only) ──
  const diagKey = String(req.query.key || 'zz-diag/probe.mp4');
  const uploadId = String(req.query.uploadId || '');
  if (['mpcreate', 'mpcomplete', 'mpabort', 'del'].includes(op) && !diagKey.startsWith('zz-diag/')) {
    return res.status(400).json({ message: 'probe ops are restricted to zz-diag/ keys.' });
  }

  if (op === 'mpcreate') {
    try {
      const created = await c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: diagKey, ContentType: 'video/mp4' }));
      const partUrl = await getSignedUrl(c, new UploadPartCommand({ Bucket: bucket, Key: diagKey, UploadId: created.UploadId, PartNumber: 1 }), { expiresIn: 900 });
      return res.status(200).json({ outcome: 'success', key: diagKey, uploadId: created.UploadId, partUrl });
    } catch (e: any) {
      return res.status(200).json({ outcome: 'error', step: 'create', name: e?.name ?? null, code: e?.Code ?? e?.code ?? null, httpStatusCode: e?.$metadata?.httpStatusCode ?? null, message: e?.message ?? null });
    }
  }

  if (op === 'mpcomplete') {
    const etag = String(req.query.etag || '');
    if (!uploadId || !etag) return res.status(400).json({ message: 'uploadId and etag required.' });
    try {
      await c.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: diagKey, UploadId: uploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] } }));
      const h = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: diagKey }));
      return res.status(200).json({ outcome: 'success', key: diagKey, size: h.ContentLength ?? null });
    } catch (e: any) {
      return res.status(200).json({ outcome: 'error', step: 'complete', name: e?.name ?? null, code: e?.Code ?? e?.code ?? null, httpStatusCode: e?.$metadata?.httpStatusCode ?? null, message: e?.message ?? null });
    }
  }

  if (op === 'mpabort') {
    if (!uploadId) return res.status(400).json({ message: 'uploadId required.' });
    try { await c.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: diagKey, UploadId: uploadId })); return res.status(200).json({ outcome: 'success' }); }
    catch (e: any) { return res.status(200).json({ outcome: 'error', name: e?.name ?? null, message: e?.message ?? null }); }
  }

  if (op === 'del') {
    try { await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: diagKey })); return res.status(200).json({ outcome: 'success' }); }
    catch (e: any) { return res.status(200).json({ outcome: 'error', name: e?.name ?? null, message: e?.message ?? null }); }
  }

  return res.status(400).json({ message: 'op must be cors, head, mpcreate, mpcomplete, mpabort or del.' });
}
