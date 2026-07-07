/**
 * File: lib/server-i18n.ts
 * Tiny server-side translation lookup for API routes and PDF rendering, where next-i18next's
 * React hook can't reach. Reads the same public/locales JSON the client uses (one source of
 * strings), with en-GB fallback and {{var}} interpolation. Server-only — never bundle client-side.
 */
import fs from 'fs';
import path from 'path';

const cache = new Map<string, Record<string, unknown>>();

function loadNamespace(locale: string, ns: string): Record<string, unknown> | null {
  const key = `${locale}/${ns}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const file = path.join(process.cwd(), 'public', 'locales', locale, `${ns}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

function dig(obj: Record<string, unknown> | null, dotPath: string): string | null {
  if (!obj) return null;
  let cur: unknown = obj;
  for (const part of dotPath.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return null;
  }
  return typeof cur === 'string' ? cur : null;
}

/** t for the server: tServer('en-GB', 'invoice', 'warrantyLine', { reg: 'AB12CDE' }) */
export function tServer(locale: string | null | undefined, ns: string, key: string, vars?: Record<string, string | number>): string {
  const raw = dig(loadNamespace(locale || 'en-GB', ns), key) ?? dig(loadNamespace('en-GB', ns), key) ?? key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, v) => (vars && v in vars ? String(vars[v]) : `{{${v}}}`));
}
