/**
 * File: lib/dvsa.ts
 * THE one place the DVSA MOT History API is called — SERVER-SIDE ONLY. OAuth2 client-credentials: the
 * client_id/secret/api-key/token never reach the browser. Best-effort: any failure (creds not set,
 * unknown reg → 404, token/rate-limit/network error, timeout) returns null so the caller falls back to
 * manual entry and NEVER blocks a booking. Richer than DVLA VES — this returns make AND model.
 *
 * Env: DVSA_MOT_CLIENT_ID, DVSA_MOT_CLIENT_SECRET, DVSA_MOT_API_KEY, DVSA_MOT_SCOPE_URL,
 *      DVSA_MOT_TOKEN_URL, optional DVSA_MOT_API_URL (defaults to the live trade endpoint).
 */
import { normaliseOdometer } from '@/lib/odometer';
export type DvsaVehicle = {
  make?: string; model?: string; colour?: string; fuel?: string; engineCc?: number; year?: number;
  // MOT reference (from the most recent test) — feeds the display + the banked reminder feature.
  motExpiry?: string; lastMotMileage?: number; lastMotDate?: string; // ISO dates + miles
  /**
   * EVERY test's odometer, normalised to miles (lib/odometer). Server-side only — the API route
   * stores it and does NOT return it to the browser: a client-side copy of the same facts is a
   * second source to keep in step. Unreadable odometers and unrecognised units are absent, never 0.
   */
  odometerHistory?: Array<{ date: string; miles: number }>;
};

const API_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';

export function dvsaConfigured(): boolean {
  return !!(process.env.DVSA_MOT_CLIENT_ID && process.env.DVSA_MOT_CLIENT_SECRET && process.env.DVSA_MOT_API_KEY
    && process.env.DVSA_MOT_SCOPE_URL && process.env.DVSA_MOT_TOKEN_URL);
}

// Token cache — module-level, reused across calls on a warm serverless instance (DVSA rate-limits, so
// never re-auth per lookup). Refreshed a minute before expiry.
let cached: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string | null> {
  if (cached && cached.expiresAt > Date.now() + 60_000) { console.log('[dvsa] token: reusing cached'); return cached.token; }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.DVSA_MOT_CLIENT_ID as string,
    client_secret: process.env.DVSA_MOT_CLIENT_SECRET as string,
    scope: process.env.DVSA_MOT_SCOPE_URL as string,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    console.log('[dvsa] token: POST', process.env.DVSA_MOT_TOKEN_URL);
    const res = await fetch(process.env.DVSA_MOT_TOKEN_URL as string, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctrl.signal,
    });
    console.log('[dvsa] token: status', res.status);
    if (!res.ok) { console.error('[dvsa] token FAILED', res.status, (await res.text()).slice(0, 300)); return null; }
    const j = (await res.json()) as any;
    if (!j?.access_token) { console.error('[dvsa] token: no access_token in response'); return null; }
    cached = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 1800) * 1000 };
    console.log('[dvsa] token: OK, expires_in', j.expires_in);
    return cached.token;
  } catch (e: any) {
    console.error('[dvsa] token: exception', e?.name || e?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const parseInt10 = (v: any): number | undefined => {
  const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
// MOT dates come dotted ("2024.05.20") or ISO — parse defensively; null on any doubt (nice-to-have field).
/**
 * A DVSA date, as an ISO day. Two shapes arrive and one of them used to destroy the other.
 *
 * ── THE LEGACY SHAPE, AND WHY THE REPLACEMENT EXISTS ────────────────────────────────────────────
 * Older records carry dotted dates — `2016.07.31`, sometimes `2016.07.31 09:58:48` — which
 * Date.parse will not take. Swapping the dots for hyphens fixes them. That is the ONLY reason this
 * replacement is here, and without this note somebody deletes it as noise and quietly loses every
 * pre-2018 test.
 *
 * ── WHY IT IS NOW CONDITIONAL ───────────────────────────────────────────────────────────────────
 * Current records carry a full ISO timestamp — `2026-07-31T09:58:48.000Z` — and replacing dots
 * UNCONDITIONALLY turned that into `2026-07-31T09:58:48-000Z`, which Date.parse rejects. Every
 * completedDate parsed as undefined and the whole odometer history was filtered away.
 *
 * That is why 221 real cars had ZERO MOT-sourced readings between them. `expiryDate` is date-only
 * (`2027-08-02`, no dots), so motExpiry always worked — which is exactly what made the fault
 * invisible: the lookup looked healthy and returned a date, while silently dropping seventeen
 * odometer readings per car.
 */
const parseMotDate = (v: any): string | undefined => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  // Only the legacy dotted DAY leads the string. An ISO timestamp is left exactly as it is.
  const normalised = /^\d{4}\.\d{2}\.\d{2}/.test(s) ? s.replace(/\./g, '-') : s;
  const t = Date.parse(normalised);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
};

/** Exported for the gate: the parse is the difference between a rate and no rate. */
export const __parseMotDateForTest = parseMotDate;

/**
 * WHICH MOT FIELDS TO WRITE BACK, given what we hold and what DVSA just said.
 *
 * ── REFRESH, DO NOT MERELY FILL ─────────────────────────────────────────────────────────────────
 * The first backfill wrote the expiry only when the column was empty (`&& !v.mot_expiry`). That is
 * the right instinct for filling holes and the wrong one for a field DVSA is authoritative for: we
 * do not hold a better MOT expiry than DVSA does, so there is nothing to protect. The consequence,
 * measured 19 Aug 2026 on TMBS: the sweep looked up all 221 cars, filled 67 blanks, and refreshed
 * NOTHING — so every date on the marketing page was as old as the last time we happened to see the
 * car. SH64HWW showed 22 July 2026, a month in the past, having been looked up that same evening.
 *
 * ── AND ABSENCE NEVER OVERWRITES ────────────────────────────────────────────────────────────────
 * A DVSA response with no expiry is far more likely a lookup miss, a car with no test history yet,
 * or a field we could not parse than a car that genuinely lost its MOT. Honest-null: we refuse to
 * turn "we did not learn anything" into "there is nothing to know". An EARLIER expiry does
 * overwrite — that is DVSA correcting us, which is the case this exists to serve.
 *
 * PURE, so both directions are provable without a network call, and shared because the per-row
 * refresh button will be its second caller.
 */
export type MotFieldsNow = { mot_expiry: Date | null; last_mot_mileage: number | null; last_mot_date: Date | null };
export type MotFieldWrite = Partial<MotFieldsNow>;

export function motFieldsToWrite(current: MotFieldsNow, incoming: DvsaVehicle | null): MotFieldWrite {
  const out: MotFieldWrite = {};
  if (!incoming) return out; // no response at all — never a reason to erase anything
  const day = (iso?: string) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
  const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

  const expiry = day(incoming.motExpiry);
  if (expiry && !same(expiry, current.mot_expiry)) out.mot_expiry = expiry;

  // The two the rate depends on, held to the same rule. They were stale for the same reason.
  if (incoming.lastMotMileage != null && incoming.lastMotMileage !== current.last_mot_mileage) {
    out.last_mot_mileage = incoming.lastMotMileage;
  }
  const lastDate = day(incoming.lastMotDate);
  if (lastDate && !same(lastDate, current.last_mot_date)) out.last_mot_date = lastDate;

  return out;
}

export async function dvsaLookup(registration: string): Promise<DvsaVehicle | null> {
  const reg = (registration || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Env presence — NAMES/booleans only, never values.
  console.log('[dvsa] lookup', reg, 'env:', {
    CLIENT_ID: !!process.env.DVSA_MOT_CLIENT_ID, CLIENT_SECRET: !!process.env.DVSA_MOT_CLIENT_SECRET,
    API_KEY: !!process.env.DVSA_MOT_API_KEY, SCOPE_URL: !!process.env.DVSA_MOT_SCOPE_URL, TOKEN_URL: !!process.env.DVSA_MOT_TOKEN_URL,
  });
  if (!dvsaConfigured() || !reg) { console.warn('[dvsa] not configured or empty reg → skipping'); return null; }
  const token = await getToken();
  if (!token) return null;

  const url = (process.env.DVSA_MOT_API_URL || API_BASE) + encodeURIComponent(reg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    console.log('[dvsa] MOT API: GET', url);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-API-Key': process.env.DVSA_MOT_API_KEY as string, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    console.log('[dvsa] MOT API: status', res.status);
    if (!res.ok) { console.error('[dvsa] MOT API FAILED', res.status, (await res.text()).slice(0, 300)); return null; } // 404 unknown / 403 auth / 429 rate-limited / 5xx → manual
    const d = (await res.json()) as any;
    // motTests are newest-first; take the most recent expiry + odometer + test date where present.
    const tests: any[] = Array.isArray(d.motTests) ? d.motTests : [];
    const withExpiry = tests.find((t) => t?.expiryDate);
    const withOdo = tests.find((t) => t?.odometerValue);
    // THE WHOLE HISTORY, not just the newest. It is already in this response; keeping three scalars
    // from a ten-test array was throwing away the only thing that can produce a mileage RATE, and a
    // rate is what makes "due in 10k miles or 11/2025" orderable at all. Normalised through
    // lib/odometer (unit-aware, refuses unreadable odometers) — a null reading is dropped, never
    // stored as zero.
    const odometerHistory = tests
      .map((t) => ({ date: parseMotDate(t?.completedDate), miles: normaliseOdometer(t?.odometerValue, t?.odometerUnit, t?.odometerResultType) }))
      .filter((r): r is { date: string; miles: number } => typeof r.date === 'string' && r.miles != null);
    // Year of manufacture — DVSA gives dates, not a bare year; take the first 4-digit year we find.
    const yearOf = (): number | undefined => {
      for (const f of [d.manufactureDate, d.firstUsedDate, d.registrationDate]) {
        const y = parseInt(String(f ?? '').slice(0, 4), 10);
        if (y >= 1900 && y <= 2100) return y;
      }
      return undefined;
    };
    const out = {
      make: d.make ? String(d.make) : undefined,
      model: d.model ? String(d.model) : undefined,
      colour: d.primaryColour ? String(d.primaryColour) : undefined,
      fuel: d.fuelType ? String(d.fuelType) : undefined,
      engineCc: parseInt10(d.engineSize),
      year: yearOf(),
      motExpiry: parseMotDate(withExpiry?.expiryDate),
      lastMotMileage: parseInt10(withOdo?.odometerValue),
      lastMotDate: parseMotDate(tests[0]?.completedDate),
      odometerHistory,
    };
    console.log('[dvsa] parsed:', { make: out.make, model: out.model, colour: out.colour, fuel: out.fuel, engineCc: out.engineCc, year: out.year, motExpiry: out.motExpiry, lastMotMileage: out.lastMotMileage });
    return out;
  } catch (e: any) {
    console.error('[dvsa] MOT API: exception', e?.name || e?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
