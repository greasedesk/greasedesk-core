/**
 * File: lib/environment.ts
 * WHICH DATABASE AM I — the marker half of the guard, read from the database itself.
 *
 * scripts/_db-target.mjs answers the same question from the connection string, before any schema
 * exists. This one asks the database, which is the PRIMARY check: a connection string can be
 * repointed at a restored copy of production and still hash to something unfamiliar, while a row
 * inside the data travels with the data.
 *
 * Two readers:
 *   gatePrisma        refuses to hand a gate a client unless this says `test`
 *   sendNotification  refuses every send when this says `test`, which is what lets a gate drive a
 *                     real signup end to end without an email leaving the building
 */
import { prisma as defaultDb } from '@/lib/db';

export type EnvironmentKind = 'production' | 'test';
export const ENVIRONMENT_ID = 'singleton';

/**
 * ── ONLY A SUCCESSFUL READ IS CACHED (owner ruling, 2026-10-26) ────────────────────────────────
 * The kind cannot change inside a process, so one successful read is enough and the rest are free.
 * A FAILED read is deliberately NOT cached. Caching a failure would mean a transient database
 * fault at boot stopped production email until the next deploy — a few seconds of trouble turned
 * into hours of silence. Unreadable is retried on the very next send.
 */
let cached: EnvironmentKind | null = null;

/** Reset between tests. Not used in production code. */
export function __resetEnvironmentCache() { cached = null; }

export type EnvironmentRead =
  | { kind: EnvironmentKind; cached: boolean }
  | { kind: null; why: 'no row' | 'unreadable'; detail: string };

export async function readEnvironment(db: any = defaultDb): Promise<EnvironmentRead> {
  if (cached) return { kind: cached, cached: true };
  try {
    const row = await db.environment.findUnique({ where: { id: ENVIRONMENT_ID }, select: { kind: true } });
    if (!row) return { kind: null, why: 'no row', detail: `no Environment row with id "${ENVIRONMENT_ID}"` };
    cached = row.kind as EnvironmentKind;
    return { kind: cached, cached: false };
  } catch (e: any) {
    return { kind: null, why: 'unreadable', detail: String(e?.message ?? e).split('\n')[0].slice(0, 160) };
  }
}

export type SendRefusal = { refuse: false } | { refuse: true; reason: string; skipCode: 'test_environment' | 'environment_unknown' };

/**
 * Should this send be refused because of WHICH DATABASE this is?
 *
 * Refuses on `test` — the whole point — and ALSO when the marker cannot be read, which is the
 * owner's ruling and the uncomfortable half. The reasoning: a test database that sends is writing
 * to real people, and an unreadable marker cannot rule that out. The cost is that a database
 * fault stops email while it lasts; it is reported loudly on every refusal rather than once, and
 * it clears the moment a read succeeds because failures are not cached.
 *
 * It CANNOT engage on production by accident: the migration that creates this row defaults it to
 * `production`, so a database that has never been configured claims to be production and sends.
 */
export async function environmentSendRefusal(db: any = defaultDb): Promise<SendRefusal> {
  const env = await readEnvironment(db);
  // THE UNKNOWN CASE FIRST, so the two known kinds below are narrowed rather than assumed. Written
  // the other way round the compiler could not tell `kind: null` apart from the others, which is
  // the shape of mistake that leaves an unhandled third state reading as one of the first two.
  if (env.kind === null) {
    // LOUD, on every refusal. A silence nobody is told about is the failure mode here.
    console.error(`[environment] REFUSING ALL SENDS: the Environment marker is unreadable (${env.why}: ${env.detail}). `
      + 'Sends resume the moment it reads again — failures are not cached. If this is production, fix it now.');
    return {
      refuse: true, skipCode: 'environment_unknown',
      reason: `could not confirm which database this is (${env.why}) — refused rather than risked`,
    };
  }
  if (env.kind === 'test') {
    return { refuse: true, skipCode: 'test_environment', reason: 'test environment — nothing is sent from the gate database' };
  }
  return { refuse: false };
}
