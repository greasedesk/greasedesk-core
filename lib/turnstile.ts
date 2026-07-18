/**
 * File: lib/turnstile.ts
 * Server-side Cloudflare Turnstile verification — called in an API route BEFORE any Resend send.
 * Env-gated: when TURNSTILE_SECRET_KEY is unset (keys not yet configured in the environment), it
 * returns { ok: true, skipped: true } so the form still works — the challenge activates the moment
 * the secret is set, no code change. When the secret IS set, a missing/failed token → { ok: false },
 * and the caller returns a CLEAR error (never a silent drop).
 *
 * ENV: TURNSTILE_SECRET_KEY (server, secret). The public NEXT_PUBLIC_TURNSTILE_SITE_KEY renders the
 * widget client-side. Set BOTH in the environment (e.g. Vercel) to activate the challenge.
 */
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token: string | null | undefined, remoteIp?: string | null): Promise<{ ok: boolean; skipped?: boolean }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true }; // not configured → don't block (activate by setting the key)
  if (!token || typeof token !== 'string') return { ok: false };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(SITEVERIFY, { method: 'POST', body });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean };
    return { ok: !!data.success };
  } catch {
    return { ok: false }; // network/parse failure → treat as failed challenge, surface an error
  }
}

/** Best-effort client IP for the siteverify remoteip hint. */
export function clientIp(headers: Record<string, string | string[] | undefined>): string | undefined {
  const xff = headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  return raw ? raw.split(',')[0].trim() : undefined;
}
