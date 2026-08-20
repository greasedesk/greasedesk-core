/**
 * File: lib/client-freshness.ts
 * IS THE PRISMA CLIENT THIS PROCESS LOADED STILL THE ONE ON DISK?
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 * `prisma generate` writes a new client into node_modules. A dev server started before that keeps
 * the OLD client in memory: new models come back `undefined`, new columns raise "Unknown field".
 * It surfaces as a 500 on one endpoint, or — worse — a panel that renders empty.
 *
 * It cost seven or eight interruptions on this project, and the expensive part was never the
 * restart. Twice in one day it sent the investigation into the wrong subsystem: a phone page that
 * would not load read as a mount-condition bug, and a queued battery reading that never arrived
 * read as an outbox bug. Both were this. A minute of restarting is nothing; twenty minutes reading
 * the wrong file is the cost.
 *
 * ── WHY THE OBVIOUS VERSION DOES NOT WORK ───────────────────────────────────────────────────────
 * The tempting check is to compare prisma/schema.prisma against the copy `generate` leaves at
 * node_modules/.prisma/client/schema.prisma. That catches "you forgot to regenerate" — which is NOT
 * this failure. Here the regenerate DID happen and the two files agree perfectly; it is the running
 * PROCESS that is behind. No comparison of two files on disk can see that, because the stale thing
 * is in memory.
 *
 * So the fingerprint has to be taken WHEN THE PROCESS LOADS THE CLIENT, and compared against the
 * file later. That is the whole idea, and it is why this is a module with boot state rather than a
 * script that could be run from the command line.
 *
 * ── DEVELOPMENT ONLY, AND NOT MERELY OUT OF HABIT ───────────────────────────────────────────────
 * In production the client is generated at build time and the server process starts afterwards, so
 * the window cannot open — there is no moment at which a running process can be older than the
 * client on disk. Enabling this in production would add a file read to the hot path to detect a
 * state that cannot occur. If a future reader notices the asymmetry and "tidies" it by removing the
 * environment check, that is the change to refuse.
 *
 * ── AND IT DOES NOT EXIT ────────────────────────────────────────────────────────────────────────
 * Exiting so a supervisor restarts is tempting and wrong: the dev server is not always supervised,
 * and dying part-way through a migration is a worse surprise than the error. It throws, loudly,
 * with the fix in the message. A human decides what to do about it.
 */
// BARE SPECIFIERS, not the `node:` prefix. This project's webpack config does not handle the
// `node:` scheme, and the prefixed form broke every page that reaches lib/db — which is all of
// them. Worth the note: a guard whose job is to stop a broken thing reading as a broken feature
// spent its first five minutes being exactly that. The rest of the codebase uses bare specifiers
// (see lib/magic-link); match it.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

/** The copy of the schema that `prisma generate` leaves beside the client it built. */
export const GENERATED_SCHEMA_PATH = path.join(
  process.cwd(), 'node_modules', '.prisma', 'client', 'schema.prisma',
);

/** Cheap and sufficient: any regenerate rewrites this file, and we only need "same or not". */
export function fingerprint(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

/**
 * The fingerprint on disk right now, or NULL when it cannot be read.
 *
 * NULL is honest and load-bearing: a missing file means we do not know, and "do not know" must
 * never be reported as "stale". A guard that fires on its own inability to check is a guard that
 * gets switched off within a week.
 */
export function readFingerprint(file: string = GENERATED_SCHEMA_PATH): string | null {
  try {
    return fingerprint(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * THE RULE, pure: is the running process behind the client on disk?
 *
 * Stale requires BOTH sides to be known AND different. Every other combination is "we cannot say",
 * which is not the same answer — see the null note above.
 */
export function isStale(bootPrint: string | null, diskPrint: string | null): boolean {
  return bootPrint !== null && diskPrint !== null && bootPrint !== diskPrint;
}

/** Captured once, when this module is first loaded — which is when the client is loaded with it. */
const BOOT_PRINT: string | null = readFingerprint();

/** Re-reading a 200KB file on every query would be its own performance bug. Once a second is
 *  plenty: the thing being detected is a human running a command in another terminal. */
const CHECK_EVERY_MS = 1_000;
let lastCheckedAt = 0;
let lastAnswer = false;

export function clientIsStale(now: number = Date.now()): boolean {
  if (BOOT_PRINT === null) return false; // never checked in, so never report a drift
  if (now - lastCheckedAt < CHECK_EVERY_MS) return lastAnswer;
  lastCheckedAt = now;
  lastAnswer = isStale(BOOT_PRINT, readFingerprint());
  return lastAnswer;
}

export const STALE_CLIENT_MESSAGE = [
  '',
  '  ┌───────────────────────────────────────────────────────────────────────────┐',
  '  │  THE DEV SERVER IS RUNNING AN OLD PRISMA CLIENT.                          │',
  '  └───────────────────────────────────────────────────────────────────────────┘',
  '',
  '  `prisma generate` has run since this server started, so the client in memory',
  '  is older than the one on disk. New models read as `undefined` and new columns',
  '  raise "Unknown field" — which usually looks like the feature being broken.',
  '',
  '  IT CAN ALSO LOOK LIKE A WRONG PASSWORD. This guard throws inside any prisma call,',
  '  including the one in NextAuth\'s authorize() — and NextAuth reports every failure',
  '  there as InvalidCredentials. On 2026-08-20 that cost an hour: the login page said',
  '  the password was wrong, bcrypt confirmed it was right, and the server was simply',
  '  stale. If a correct credential is being refused, restart before investigating auth.',
  '',
  '  It is not the feature. RESTART THE DEV SERVER and it will go away.',
  '',
  '  (This check is development-only — see lib/client-freshness.)',
  '',
].join('\n');

/** Printed once per process. A banner on every query would bury the thing it is pointing at. */
let banneredAt = 0;
export function warnOnce(): void {
  if (banneredAt) return;
  banneredAt = Date.now();
  console.error(STALE_CLIENT_MESSAGE);
}
