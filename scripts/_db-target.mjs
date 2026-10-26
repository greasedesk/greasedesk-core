/**
 * File: scripts/_db-target.mjs
 * WHICH DATABASE AM I POINTED AT — answerable with no database connection at all.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * Until 2026-10-26 there was one database and dev shared it with production. Three guards encode
 * that premise — the PreToolUse hook on `prisma migrate deploy`, the migrate wrapper's "is
 * production running this code yet" ceremony, and every gate writing fixtures to the live tenant.
 * The premise has stopped being true: there is a separate gate project now. A guard whose premise
 * has expired is a blindfold, so each of them asks this module instead of assuming.
 *
 * ── HASHED, NOT NAMED ──────────────────────────────────────────────────────────────────────────
 * The comparison is against the KNOWN PRODUCTION ENDPOINT, as the owner required, not a naming
 * prefix — Neon assigns endpoint ids and a prefix rule would be a guess. It is stored as a SHA-256
 * because this repository is public. A hostname is not a credential, so this is hygiene rather
 * than security; it keeps the production host out of a public repo while still comparing against
 * the actual endpoint.
 *
 * ── AND IT FAILS CLOSED ────────────────────────────────────────────────────────────────────────
 * A URL that cannot be parsed, or an absent one, is reported as `unknown` — never as "not
 * production". Callers treat unknown the way they treat production, because the question being
 * asked is "is it SAFE to write destructively here", and silence is not a yes.
 *
 * This module is the ENDPOINT half of the guard and runs before any schema exists, which is what
 * the marker in lib/environment cannot do. The marker is the primary check once a database has a
 * schema; see gatePrisma, which requires both.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

/** sha256('ep-<production endpoint>') — see the header for why it is a hash. */
export const PRODUCTION_ENDPOINT_SHA256 = 'd2dc3330c7397ad46fb82a47b0667cb20822876cd37aabcd5440545c85327dce';

/**
 * The endpoint id in a Postgres URL, with any `-pooler` suffix removed so the pooled and direct
 * forms of one endpoint compare equal. Null when the URL is absent or unparseable.
 */
export function endpointOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    return new URL(url).hostname.split('.')[0].replace(/-pooler$/, '') || null;
  } catch {
    return null;
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** 'production' | 'other' | 'unknown' — never a bare boolean, because unknown is a third answer. */
export function classifyUrl(url) {
  const ep = endpointOf(url);
  if (!ep) return 'unknown';
  return sha(ep) === PRODUCTION_ENDPOINT_SHA256 ? 'production' : 'other';
}

/**
 * Read DATABASE_URL and DIRECT_URL from the environment, falling back to .env — a hook runs in a
 * bare process with neither loaded, and "no variable set" must not read as "not production".
 */
export function readDbUrls(root = '/Users/hugh/Developer/greasedesk-core') {
  const out = { DATABASE_URL: process.env.DATABASE_URL ?? null, DIRECT_URL: process.env.DIRECT_URL ?? null };
  if (out.DATABASE_URL && out.DIRECT_URL) return out;
  const file = `${root}/.env`;
  if (!existsSync(file)) return out;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)$/);
      // LAST ONE WINS, matching dotenv. The file carried a duplicated DATABASE_URL on 2026-10-26
      // — production at line 8, the gate database at line 69 — and a first-wins reader disagreed
      // with the running app about which database it was talking to.
      if (m && !out[m[1]]) out[m[1]] = null;
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') || out[m[1]];
    }
  } catch { /* unreadable .env leaves the values null, which classifies as unknown */ }
  return out;
}

/**
 * The verdict for BOTH urls together. `safe` is true only when each one is positively known to be
 * somewhere other than production — one unknown, or one still pointing at production, is not safe.
 * The asymmetric case is the dangerous one and the reason this looks at both: on 2026-10-26
 * DATABASE_URL had moved to the gate project while DIRECT_URL still named production, so the
 * migrations would have run against production while everything else read the gate database.
 */
export function describeTarget(root) {
  const urls = readDbUrls(root);
  const runtime = classifyUrl(urls.DATABASE_URL);
  const migrations = classifyUrl(urls.DIRECT_URL);
  return {
    runtime, migrations,
    runtimeEndpoint: endpointOf(urls.DATABASE_URL),
    migrationsEndpoint: endpointOf(urls.DIRECT_URL),
    samePair: endpointOf(urls.DATABASE_URL) != null
      && endpointOf(urls.DATABASE_URL) === endpointOf(urls.DIRECT_URL),
    safe: runtime === 'other' && migrations === 'other',
  };
}
