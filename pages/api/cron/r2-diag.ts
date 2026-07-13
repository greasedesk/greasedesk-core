/**
 * File: pages/api/cron/r2-diag.ts
 * TEMPORARY DIAGNOSTIC (ruling 2026-07-13: report the raw GetBucketCors response verbatim, and
 * verify the first real multipart video object). DELETE after the CORS false-negative post-mortem
 * — this route exists for one report. CRON_SECRET Bearer guard (same as confirm-paid); runs
 * server-side where the R2 credentials live. READ-ONLY against the bucket.
 *   GET ?op=cors        → raw GetBucketCors outcome: rules or the full error (name/code/status/message)
 *   GET ?op=head&key=…  → HeadObject: size/type/etag for a key (verify the walkaround landed)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { S3Client, GetBucketCorsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

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

  return res.status(400).json({ message: 'op must be cors or head.' });
}
