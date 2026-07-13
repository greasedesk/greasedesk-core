/**
 * File: pages/api/cron/mov-diag.ts
 * TEMPORARY read-only probe (ruling 2026-07-13, portrait-renders-landscape diagnosis): ranged-read
 * a stored MOV/MP4 object and parse the QuickTime tkhd rotation matrix + display dims and the video
 * sample entry's coded dims — the ffprobe-equivalent, since ffprobe isn't on Vercel. CRON_SECRET
 * Bearer guard. READS ONLY; DELETE once the diagnosis is filed.
 *   GET ?key=<r2 key>  → { rotation, coded, display, moovAt }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

function client(): S3Client | null {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
}
async function range(c: S3Client, key: string, start: number, end: number): Promise<Buffer> {
  const r = await c.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME as string, Key: key, Range: `bytes=${start}-${end}` }));
  const chunks: Uint8Array[] = [];
  let len = 0;
  for await (const ch of r.Body as any) { const u = ch as Uint8Array; chunks.push(u); len += u.length; }
  const merged = new Uint8Array(len);
  let off = 0;
  for (const u of chunks) { merged.set(u, off); off += u.length; }
  return Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength);
}

function parse(buf: Buffer) {
  const out: any = { tkhd: [], stsd: [] };
  function walk(start: number, end: number) {
    let o = start;
    while (o + 8 <= end) {
      const size = buf.readUInt32BE(o);
      const type = buf.toString('latin1', o + 4, o + 8);
      if (size < 8) break;
      const boxEnd = size === 1 ? end : o + size; // ignore 64-bit largesize for these small header boxes
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(o + 8, Math.min(boxEnd, end));
      else if (type === 'tkhd') {
        const version = buf[o + 8];
        const afterTimes = o + 8 + 4 /*ver+flags*/ + (version === 1 ? 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4); // create,modify,trackID,reserved,duration
        const matOff = afterTimes + 8 /*reserved[2]*/ + 2 /*layer*/ + 2 /*altgroup*/ + 2 /*volume*/ + 2 /*reserved*/;
        const a = buf.readInt32BE(matOff);       // 16.16
        const b = buf.readInt32BE(matOff + 4);   // 16.16
        const w = buf.readUInt32BE(matOff + 36) / 65536;
        const h = buf.readUInt32BE(matOff + 40) / 65536;
        const deg = ((Math.round(Math.atan2(b / 65536, a / 65536) * 180 / Math.PI)) + 360) % 360;
        out.tkhd.push({ rotationDeg: deg, matrix_a: +(a / 65536).toFixed(3), matrix_b: +(b / 65536).toFixed(3), displayW: w, displayH: h });
      } else if (type === 'stsd') {
        // fullbox(4) + entryCount(4) → sample entry: size(4)+format(4)+reserved(6)+dataRef(2) then
        // VisualSampleEntry: predefined(2)+reserved(2)+predefined[3](12) then width(2) height(2).
        const e = o + 8 + 4 + 4;
        const w = buf.readUInt16BE(e + 8 + 8 + 16);
        const h = buf.readUInt16BE(e + 8 + 8 + 16 + 2);
        const fmt = buf.toString('latin1', e + 4, e + 8);
        out.stsd.push({ codec: fmt, codedW: w, codedH: h });
      }
      o = boxEnd;
    }
  }
  walk(0, buf.length);
  return out;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ message: 'Not authorised.' });
  const c = client(); if (!c) return res.status(503).json({ message: 'R2 not configured.' });
  const key = String(req.query.key || ''); if (!key) return res.status(400).json({ message: 'key required.' });
  try {
    const head = await c.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME as string, Key: key }));
    const total = head.ContentLength ?? 0;
    // moov is usually at the front for iOS (faststart) but not guaranteed — try head, then tail.
    let parsed = parse(await range(c, key, 0, Math.min(total - 1, 1024 * 1024 - 1)));
    let moovAt = 'head';
    if (!parsed.tkhd.length && total > 1024 * 1024) { parsed = parse(await range(c, key, Math.max(0, total - 1024 * 1024), total - 1)); moovAt = 'tail'; }
    return res.status(200).json({ key, size: total, moovAt, ...parsed });
  } catch (e: any) {
    return res.status(200).json({ outcome: 'error', name: e?.name ?? null, message: e?.message ?? null });
  }
}
