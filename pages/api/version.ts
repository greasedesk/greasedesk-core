/**
 * File: pages/api/version.ts
 * WHICH COMMIT IS PRODUCTION RUNNING? Public, unauthenticated, four fields, nothing else.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * Dev and production share one database, so a migration is LIVE the moment it is applied while the
 * code that honours it is not live until it deploys. On 2026-09-11 a trigger was applied at 17:43
 * UTC and production went on running the previous commit, whose owner-edit API wrote the constrained
 * columns directly: every "No SMS / No email" save on the live app returned 500 for about four hours.
 * Nothing could see it from here, because nothing here could say what production was RUNNING.
 *
 * So: the deploy check the migration wrapper will make (a constraining migration may only be applied
 * once the code that satisfies it is live) asks THIS. It is also worth having on its own — "what is
 * live right now" should not require opening the Vercel dashboard.
 *
 * ── PUBLIC, AND WHY THAT IS SAFE ────────────────────────────────────────────────────────────────
 * A commit hash of a private repository identifies a build; it grants nothing and reveals no code.
 * Authenticating it would defeat the purpose: the caller is a script that runs before anyone signs
 * in, and often when something is already wrong. The response carries FOUR fields and no others —
 * version-endpoint-gate pins the exact set, so a later "just add the database URL for debugging"
 * fails a gate rather than shipping.
 *
 * ── HONEST NULL ─────────────────────────────────────────────────────────────────────────────────
 * On a machine that is not a Vercel build there IS no commit: `commit` is null and `source` says
 * `unknown`, rather than a hostname, a timestamp or "local" pretending to be a version. A caller
 * comparing against null must fail closed, and the wrapper will.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

/** Set at BUILD time by next.config.js from Vercel's own variable; the runtime read is preferred. */
const BUILT_FROM = process.env.BUILD_COMMIT || '';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const runtime = process.env.VERCEL_GIT_COMMIT_SHA || '';
  const commit = runtime || BUILT_FROM || null;
  return res.status(200).json({
    commit,
    ref: process.env.VERCEL_GIT_COMMIT_REF || null,
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    // WHICH READ ANSWERED. Vercel exposes its system variables to the running function as well as to
    // the build; if that ever stops being true, this says `build` and the answer is still right.
    source: runtime ? 'runtime' : BUILT_FROM ? 'build' : 'unknown',
  });
}
