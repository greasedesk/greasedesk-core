/**
 * File: pages/api/dev/client-freshness.ts
 * IS THIS SERVER'S PRISMA CLIENT STALE? A DIAGNOSTIC, AND NOTHING ELSE.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A CUSTOMER PAGE ──────────────────────────────────────────
 * The gate suite has always answered this by fetching /c/aaaaaaaaaaaaaaaa — a CUSTOMER MAGIC LINK
 * path — and reading the guard's banner out of the HTML. That worked, and it spent a customer's
 * rate-limit budget to do it: `magic:ip` is 60 per hour, and the runner spends one per invocation
 * while twenty-five gates spend another each TIME THEY FAIL. Reds cause exhaustion, exhaustion
 * causes reds, and on 2026-09-09 five gates went red for that reason and no other.
 *
 * A diagnostic sharing a route with a customer surface is what made that loop, so this one has its
 * own route, its own name, and no customer semantics at all.
 *
 * ── DEVELOPMENT ONLY, ENFORCED, NOT CONVENTIONAL ────────────────────────────────────────────────
 * 404 in production — the same undiscoverable refusal the Engine Room uses, so this leaks no
 * information about what exists. The condition it reports CANNOT OCCUR in production: the client is
 * generated at build time and the server starts afterwards, so no running process can be older than
 * the client on disk (see lib/client-freshness, which makes the same argument for the same reason).
 * An endpoint reporting an impossible state is an endpoint with no reason to be reachable.
 *
 * ── UNAUTHENTICATED, BY DESIGN ──────────────────────────────────────────────────────────────────
 * Deliberate, and worth stating so nobody "fixes" it: the answer is one boolean about the DEVELOPER'S
 * OWN machine, it carries no tenant data, and requiring a session would mean the diagnostic could
 * not run before a session exists — which is exactly when a stale client is being diagnosed.
 * Unreachable in production, so there is no surface to protect.
 *
 * ── AND IT IS NOT RATE LIMITED ──────────────────────────────────────────────────────────────────
 * That is the entire point. If a future reader adds a limiter here to be consistent with the other
 * public routes, they will have rebuilt the loop this file was written to break.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
// lib/db IS IMPORTED FOR ITS SIDE EFFECT, and that is the whole mechanism: lib/client-freshness
// captures BOOT_PRINT when it is first loaded, which lib/db does when the client is loaded with it.
// Asking the predicate without that would fingerprint whenever this route first compiled, and
// answer about the wrong moment.
import { prisma } from '@/lib/db';
import { clientIsStale } from '@/lib/client-freshness';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ message: 'Not found.' });
  void prisma;                                    // the import is the point; this keeps it
  return res.status(200).json({ stale: clientIsStale(), checkedAt: new Date().toISOString() });
}
