/**
 * File: lib/anchored-match.ts
 * A PROPERTY KEY OR A PATH SEGMENT, MATCHED AS ITSELF — never as the tail of a longer name, never as
 * the head of a longer path. The anchoring is built in, so nobody has to remember to write it.
 *
 * ── WHY THIS EXISTS: THE TWO THAT GOT THROUGH ────────────────────────────────────────────────────
 *   `startsWith('/api/rep')` in middleware.ts also matched /api/reports/vat-summary — a tenant's VAT
 *   return. Shipping the rep portal would have 404'd it on the apex. (2026-09-09)
 *   /email\s*:/ in rep-auth-gate also matched `contact_email:` — the address a rep publishes on their
 *   invoice and may edit — and flagged a correct route as writing the credential. (2026-09-09)
 * Both were hand-written, both were the substring trap, and the suite had met that trap eight times
 * before them. A rule everybody knows and each author re-implements is a rule with one fresh chance to
 * be wrong per author. anchored-match-gate bans gates from writing their own; this is what they call.
 *
 * ── THE TWO EDGES ────────────────────────────────────────────────────────────────────────────────
 *   A KEY starts where no identifier character, `$` or `.` precedes it — so `email` is not found in
 *   `contact_email` or `user.email` — and is followed directly by `:` (or `?:` only when the key is
 *   written with its `?`). A quoted key ('email': or "email":) is the same key.
 *   A VALUE given as text is matched literally, whitespace-flexible, and — when it ends in an
 *   identifier character — must END there: `true` is not found in `trueish`.
 *   A PATH is the segment itself or anything beneath it: /api/rep and /api/rep/x, never /api/reports.
 *
 * LEAF: imports nothing. middleware.ts runs it on the Edge runtime, and gates load it directly.
 */

const IDENT = /^[A-Za-z_$][\w$]*\??$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function keySource(key: string): string {
  if (!IDENT.test(key)) throw new Error(`anchored-match: "${key}" is not a property name`);
  const optional = key.endsWith('?');
  const name = esc(optional ? key.slice(0, -1) : key);
  const q = optional ? '\\?' : '';
  return `(?:(?<![\\w$.])${name}${q}|'${name}'${q}|"${name}"${q})\\s*:`;
}

function valueSource(value: string | RegExp): string {
  if (value instanceof RegExp) return value.source;
  const v = value.trim();
  const lit = v.split(/\s+/).map(esc).join('\\s+');
  return /[\w$]$/.test(v) ? `${lit}(?![\\w$])` : lit;
}

/**
 * THE PRIMITIVE: a RegExp for `key:` (and, if given, its value), anchored. `value` as text is literal;
 * as a RegExp its source is used as written — for capture groups, alternations, `[^;]*`. Flags pass
 * through, so matchAll and extraction work: keyRegex('onDelete', /(\w+)/, 'g').
 */
export function keyRegex(key: string, value?: string | RegExp, flags = ''): RegExp {
  return new RegExp(`${keySource(key)}${value === undefined ? '' : `\\s*${valueSource(value)}`}`, flags);
}

/** Does `src` carry `key:` (with `value`, if given) as a property — not as the tail of a longer name? */
export function hasKey(src: string, key: string, value?: string | RegExp): boolean {
  return keyRegex(key, value).test(src);
}

/** How many times. Count before relying on one: a key found twice is often a key found in the wrong place. */
export function countKey(src: string, key: string, value?: string | RegExp): number {
  return [...src.matchAll(keyRegex(key, value, 'g'))].length;
}

/** Is `path` the segment `base`, or beneath it? /api/rep → /api/rep and /api/rep/x; never /api/reports. */
export function underPath(path: string, base: string): boolean {
  const b = base.replace(/\/+$/, '');
  if (!b.startsWith('/')) throw new Error(`anchored-match: "${base}" is not an absolute path`);
  return path === b || path.startsWith(`${b}/`);
}

/** The same for a whole URL — a browser gate's network request. The query and the hash are not the path. */
export function urlUnder(url: string, base: string): boolean {
  let path: string;
  try { path = new URL(url, 'http://anchored.invalid').pathname; } catch { return false; }
  return underPath(path, base);
}

/**
 * A path written INSIDE text — source, HTML — as whole segments: /c/aaaa, or /c/aaaa/x, but never
 * /c/aaaab and never /x/c/aaaa. An origin in front of it (http://host:3010/c/aaaa) is allowed.
 */
export function pathRegex(path: string, flags = ''): RegExp {
  const p = path.replace(/\/+$/, '');
  if (!p.startsWith('/')) throw new Error(`anchored-match: "${path}" is not an absolute path`);
  return new RegExp(`(?:(?<=https?:\\/\\/[^/\\s'"\`]+)|(?<![\\w/.-]))${esc(p)}(?![\\w.-])`, flags);
}

export function hasPath(text: string, path: string): boolean {
  return pathRegex(path).test(text);
}
