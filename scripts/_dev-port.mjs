/**
 * File: scripts/_dev-port.mjs
 * THE DEVELOPMENT PORT. One number, one file, no imports.
 *
 * ── WHY IT IS NOT 3000, AND WHY IT IS NOT A DEFAULT ─────────────────────────────────────────────
 * It was never chosen: `next dev` picks 3000 and, WHEN THAT IS TAKEN, SILENTLY WALKS TO 3001. On
 * 2026-09-08 another project on this machine held 3000, GreaseDesk moved to 3001 without saying so
 * anywhere the suite could read, and two gates that had hardcoded the port spent a day and a half
 * driving the other application. Their reds were not reds.
 *
 * The other project was not the cause. Two gates were hardcoded and the runner's probe asserted
 * liveness rather than identity; ANY process on 3000 would have produced the same result. What the
 * silent walk added was that nothing said the move had happened.
 *
 * So: an uncommon port, passed EXPLICITLY, so Next fails on a clash instead of moving. A dev server
 * that quietly relocates is worse than one that stops — the stop is a sentence you read, the move
 * is a day and a half.
 *
 * ── NO IMPORTS, DELIBERATELY ────────────────────────────────────────────────────────────────────
 * scripts/dev.mjs, scripts/_gate-preflight.mjs and scripts/gates.mjs all need this number, and the
 * first two cannot import each other: dev.mjs starts a server at module scope, and _gate-preflight
 * refuses to load when stdout is a pipe. A dependency-free module is the only thing all three can
 * reach — the same arrangement lib/magic-link-days and lib/operator-roles already have, and for the
 * same reason.
 *
 * Moving it is a one-line change here. NEXTAUTH_URL in .env must move with it, or every login page
 * 500s on `Error serializing .csrfToken` — NextAuth resolves its own origin from that variable and
 * GATE_BASE cannot reach it.
 */
export const DEV_PORT = 3010;
