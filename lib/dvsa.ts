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
export type DvsaVehicle = {
  make?: string; model?: string; colour?: string; fuel?: string; engineCc?: number;
  motExpiry?: string; lastMotMileage?: number; // ISO date + miles, for the banked reminder feature
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
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.DVSA_MOT_CLIENT_ID as string,
    client_secret: process.env.DVSA_MOT_CLIENT_SECRET as string,
    scope: process.env.DVSA_MOT_SCOPE_URL as string,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(process.env.DVSA_MOT_TOKEN_URL as string, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    if (!j?.access_token) return null;
    cached = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 1800) * 1000 };
    return cached.token;
  } catch {
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
const parseMotDate = (v: any): string | undefined => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const t = Date.parse(s.replace(/\./g, '-'));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
};

export async function dvsaLookup(registration: string): Promise<DvsaVehicle | null> {
  const reg = (registration || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!dvsaConfigured() || !reg) return null;
  const token = await getToken();
  if (!token) return null;

  const url = (process.env.DVSA_MOT_API_URL || API_BASE) + encodeURIComponent(reg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-API-Key': process.env.DVSA_MOT_API_KEY as string, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // 404 unknown / 403 auth / 429 rate-limited / 5xx → manual
    const d = (await res.json()) as any;
    // motTests are newest-first; take the most recent expiry + odometer where present.
    const tests: any[] = Array.isArray(d.motTests) ? d.motTests : [];
    const withExpiry = tests.find((t) => t?.expiryDate);
    const withOdo = tests.find((t) => t?.odometerValue);
    return {
      make: d.make ? String(d.make) : undefined,
      model: d.model ? String(d.model) : undefined,
      colour: d.primaryColour ? String(d.primaryColour) : undefined,
      fuel: d.fuelType ? String(d.fuelType) : undefined,
      engineCc: parseInt10(d.engineSize),
      motExpiry: parseMotDate(withExpiry?.expiryDate),
      lastMotMileage: parseInt10(withOdo?.odometerValue),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
