/**
 * File: lib/vin-shadow.ts
 * THE OCR shadow pass (fortnight floor trial, ruling 2026-07-13): runs server-side on every
 * slot='vin' photo AFTER the outbox drains it (called inline from the photo COMMIT — the caller
 * is the service worker's drain, never a waiting human). HYBRID: cloud OCR first (Google Vision,
 * GOOGLE_VISION_API_KEY), Claude Haiku vision as fallback when no checksum-valid candidate
 * emerges (ANTHROPIC_API_KEY). LOGS ONLY — one VinReadShadow row per engine attempt: candidates,
 * validity (lib/vin — the same gate the human's typing passes), latency, cost. OFFERS NOTHING:
 * no UI reads this table; the "Suggested VIN — Accept?" card ships only if the trial's number
 * earns it. Env-gated: with no keys, a 'skipped' row still counts the photo.
 *
 * THE TRIAL'S ONE NUMBER (analysis at fortnight end, run ad-hoc):
 *   of vin photos taken, the proportion whose checksum-valid candidate EQUALS the VIN a human
 *   subsequently typed — join VinReadShadow.candidates (valid) → JobCard → Vehicle.vin.
 * Failures here must never fail the photo commit — every path is caught.
 */
import { prisma } from '@/lib/db';
import { presignGet } from '@/lib/r2';
import { isValidVin, normaliseVinInput, VIN_SHAPE_RE } from '@/lib/vin';

type Candidate = { c: string; valid: boolean; source: 'raw' | 'normalised' };

/** Extract 17-char VIN candidates from arbitrary OCR text: raw windows plus ONE deterministic
 *  confusable normalisation (I→1, O→0, Q→0) — logged separately so the analysis can tell them apart.
 *  Per-line first (a plate line usually IS the VIN), then cross-line flattened; collect uncapped
 *  and cap AFTER sorting valid-first so junk windows can never crowd out the hit. */
export function extractVinCandidates(text: string): Candidate[] {
  const out = new Map<string, Candidate>();
  const scan = (s: string, source: Candidate['source']) => {
    const flat = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (let i = 0; i + 17 <= flat.length; i++) {
      const w = flat.slice(i, i + 17);
      if (!VIN_SHAPE_RE.test(w)) continue;
      if (!out.has(w)) out.set(w, { c: w, valid: isValidVin(w), source });
    }
  };
  const normalised = text.toUpperCase().replace(/I/g, '1').replace(/[OQ]/g, '0');
  for (const line of text.split(/\n+/)) scan(line, 'raw');
  for (const line of normalised.split(/\n+/)) scan(line, 'normalised');
  scan(text, 'raw');
  scan(normalised, 'normalised');
  return [...out.values()].sort((a, b) => Number(b.valid) - Number(a.valid)).slice(0, 10);
}

async function log(row: { groupId: string; photoId: string; jobCardId: string; engine: string; candidates?: Candidate[]; latencyMs: number; costMicroDollars?: number }) {
  try {
    await prisma.vinReadShadow.create({
      data: {
        group_id: row.groupId, photo_id: row.photoId, job_card_id: row.jobCardId, engine: row.engine,
        candidates: (row.candidates ?? []) as any,
        checksum_valid: (row.candidates ?? []).some((c) => c.valid),
        latency_ms: row.latencyMs, cost_microdollars: row.costMicroDollars ?? null,
      },
    });
  } catch (e) { console.error('[vin-shadow] log failed', e); }
}

async function runOcr(imageUrl: string): Promise<{ text: string; costMicroDollars: number } | null> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { source: { imageUri: imageUrl } }, features: [{ type: 'TEXT_DETECTION' }] }] }),
  });
  if (!res.ok) throw new Error(`vision:${res.status}`);
  const data = await res.json();
  return { text: data?.responses?.[0]?.fullTextAnnotation?.text ?? '', costMicroDollars: 1500 }; // ~$1.50/1000 images
}

async function runHaiku(imageUrl: string): Promise<{ text: string; costMicroDollars: number } | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`image:${img.status}`);
  const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'This photo shows a vehicle VIN plate, usually etched text between asterisks, possibly rotated or reflective. Reply with ONLY the 17-character VIN (letters/digits, no I, O or Q), or the word NONE if you cannot read one confidently.' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`haiku:${res.status}`);
  const data = await res.json();
  const text = (data?.content?.[0]?.text ?? '').trim();
  // Haiku pricing ≈ $1/M input, $5/M output → µ$ = tokens × (1 or 5).
  const cost = Math.round((data?.usage?.input_tokens ?? 0) * 1 + (data?.usage?.output_tokens ?? 0) * 5);
  return { text: text === 'NONE' ? '' : text, costMicroDollars: cost };
}

/** The shadow pass. NEVER throws — the photo commit must never fail because of it. */
export async function runVinShadow(args: { groupId: string; photoId: string; jobCardId: string; r2Key: string }): Promise<void> {
  const { groupId, photoId, jobCardId, r2Key } = args;
  try {
    const url = await presignGet(r2Key);
    if (!url) { await log({ groupId, photoId, jobCardId, engine: 'skipped', latencyMs: 0 }); return; }

    // Engine 1: cloud OCR.
    let hadValid = false;
    let t0 = Date.now();
    try {
      const ocr = await runOcr(url);
      if (ocr === null) {
        await log({ groupId, photoId, jobCardId, engine: 'skipped', latencyMs: 0 }); // no key configured — still counts the photo
      } else {
        const cands = extractVinCandidates(ocr.text);
        hadValid = cands.some((c) => c.valid);
        await log({ groupId, photoId, jobCardId, engine: 'ocr', candidates: cands, latencyMs: Date.now() - t0, costMicroDollars: ocr.costMicroDollars });
      }
    } catch (e: any) {
      await log({ groupId, photoId, jobCardId, engine: 'error:ocr', latencyMs: Date.now() - t0 });
    }

    // Engine 2: Haiku vision — only when OCR produced no checksum-valid candidate (hybrid ruling).
    if (!hadValid) {
      t0 = Date.now();
      try {
        const hk = await runHaiku(url);
        if (hk !== null) {
          const raw = normaliseVinInput(hk.text);
          const cands = extractVinCandidates(raw);
          await log({ groupId, photoId, jobCardId, engine: 'haiku', candidates: cands, latencyMs: Date.now() - t0, costMicroDollars: hk.costMicroDollars });
        }
      } catch (e: any) {
        await log({ groupId, photoId, jobCardId, engine: 'error:haiku', latencyMs: Date.now() - t0 });
      }
    }
  } catch (e) {
    console.error('[vin-shadow] pass failed', e); // logged, swallowed — shadow means shadow
  }
}
