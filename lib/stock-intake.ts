/**
 * File: lib/stock-intake.ts
 *
 * THE AUCTION INVOICE, TURNED INTO DECISIONS. Pure — no database, no Prisma, no clock beyond what
 * the caller hands in — so every rule here is testable on its own and the client can import it to
 * show the same refusal the server will give. Leaf, for the same reason lib/stock.ts is one.
 *
 * The facts on an auction invoice belong in three different places, and the whole point of this
 * module is that the split is stated once:
 *   - the CAR's own facts (VIN, first registration, import status, V5C) go on Vehicle and outlive
 *     this purchase;
 *   - the READING (mileage) is an odometer reading with a date and a source, never a column;
 *   - the SALE's terms (was the mileage warranted) belong to the StockItem, because a later owner
 *     of the same car is not covered by a warranty this auction gave us.
 */
import { normalizeVin } from '@/lib/vehicle-identity';
import { vinWarn } from '@/lib/quick-validate';

/** A calendar date the garage STATED, in the form every date on this screen arrives as. */
export function parseStatedDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T12:00:00.000Z`);  // midday UTC: no date shifts either side of midnight
  return Number.isNaN(d.getTime()) ? null : d;
}

export const isoDay = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * VIN AT INTAKE IS STRICTER THAN VIN ANYWHERE ELSE, deliberately.
 *
 * `vinWarn` is warn-only and that is right for a job card: a mistyped VIN there is a cosmetic error
 * on one document. Here the VIN becomes the tenant's canonical dedup key — VehicleIdentity carries
 * a UNIQUE on (group, vin_normalized) — so a malformed one is not a cosmetic error, it is a wrong
 * identity that every future lookup agrees with. We refuse it and say what is wrong with it.
 *
 * Empty is not an error. A garage at an auction may have the plate and nothing else, and demanding
 * a VIN it cannot see is how a feature gets worked around with a spreadsheet.
 */
export function vinAtIntake(raw: unknown): { vin: null } | { vin: string } | { refused: string } {
  if (raw === null || raw === undefined || raw === '') return { vin: null };
  if (typeof raw !== 'string') return { refused: 'The VIN must be text.' };
  const n = normalizeVin(raw);
  if (!n) return { vin: null };
  if (vinWarn(n)) {
    return {
      refused: n.length === 17
        ? 'A VIN has no letter I, O or Q — those are read as 1 and 0. Check the ones you typed.'
        : `A VIN is 17 characters and this one is ${n.length}. Check it against the logbook.`,
    };
  }
  return { vin: n };
}

/**
 * IMPORT STATUS IS THREE-STATE, and the third state is the common one.
 *
 * NULL means nobody has said. A boolean would make every car nobody asked about assert "not an
 * import", which is a claim about provenance the garage never made — and an import that reads as a
 * UK car is exactly the one that surprises somebody at resale.
 */
export function parseImportStatus(v: unknown): boolean | null {
  if (v === 'yes' || v === true) return true;
  if (v === 'no' || v === false) return false;
  return null;  // 'unknown', absent, or anything unrecognised — all mean the same: not recorded
}

/**
 * WARRANTED IS A TERM OF THE SALE, not a property of the number.
 *
 * Warranted mileage means the seller stands behind the reading. It is three-state for the same
 * reason import status is: a private purchase has no such concept, so NULL ("not stated") is a real
 * answer and not a missing one. It is attached to the StockItem because the warranty came with THIS
 * purchase; the car keeps the reading, it does not keep somebody else's guarantee of it.
 */
export function parseWarranted(v: unknown): boolean | null {
  if (v === 'yes' || v === true) return true;
  if (v === 'no' || v === false) return false;
  return null;
}

/** Miles off an invoice. Refuses a negative or an absurd number rather than storing it. */
export function parseMiles(v: unknown): { miles: null } | { miles: number } | { refused: string } {
  if (v === null || v === undefined || v === '') return { miles: null };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { refused: 'Mileage must be a whole number.' };
  if (n < 0) return { refused: 'Mileage cannot be negative.' };
  if (n > 1_500_000) return { refused: 'That mileage looks wrong — check the reading.' };
  return { miles: n };
}

export type MotNow = { motExpiry: Date | null; motCheckedAt: Date | null };
export type MotDecision =
  | { write: null; reason: 'nothing_typed' | 'agrees_with_dvsa' }
  | { write: Date; reason: 'stated_dvsa_silent' }
  | { refused: string };

/**
 * MAY A TYPED MOT DATE BE WRITTEN? The rule the owner settled: pre-populate from DVSA, accept a
 * typed one ONLY where DVSA has none, and never falsify mot_checked_at.
 *
 * `mot_checked_at` means DVSA ANSWERED — it is stamped only by motClientWrite, and only on a real
 * answer. That gives the provenance for free and needs no new column: a mot_expiry with a NULL
 * mot_checked_at is, and already reads as, a date nobody verified. So:
 *
 *   - DVSA has answered and the typed date AGREES → write nothing. Not a refusal: the form
 *     pre-populates, so agreement is the normal case and re-writing it would only risk the stamp.
 *   - DVSA has answered and the typed date DIFFERS → REFUSE, naming the verified date. Silently
 *     dropping the entry would leave the garage believing they had corrected it; silently taking it
 *     would overwrite a verified fact with a typed one. Neither is honest, so we say so.
 *   - DVSA has NOT answered → write it, and leave mot_checked_at NULL. The car now has a date and
 *     no claim that anyone checked it, which is exactly what happened.
 */
export function motExpiryDecision(now: MotNow, typed: Date | null): MotDecision {
  if (!typed) return { write: null, reason: 'nothing_typed' };
  if (now.motCheckedAt) {
    if (isoDay(now.motExpiry) === isoDay(typed)) return { write: null, reason: 'agrees_with_dvsa' };
    return {
      refused: `DVSA says this car's MOT runs to ${isoDay(now.motExpiry) ?? 'no date at all'}, and that was checked, `
        + `so a typed ${isoDay(typed)} cannot replace it. If DVSA is wrong, correct it at the source.`,
    };
  }
  return { write: typed, reason: 'stated_dvsa_silent' };
}

/**
 * First registration cannot be in the future, and cannot be after the day we bought it: a car
 * registered after it was purchased is a keying error, and one caught here costs a re-type while
 * one stored quietly wrongs every age calculation that ever reads it.
 */
export function firstRegisteredRefusal(firstRegistered: Date | null, acquiredAt: Date, today: Date): string | null {
  if (!firstRegistered) return null;
  if (firstRegistered.getTime() > today.getTime()) return 'A car cannot be first registered in the future.';
  if (firstRegistered.getTime() > acquiredAt.getTime()) {
    return `You bought it on ${isoDay(acquiredAt)} but first registration reads ${isoDay(firstRegistered)}.`;
  }
  return null;
}

/** The V5C reference as stored: trimmed, spaces out, uppercased. Never logged — see lib/redact. */
export function normaliseV5c(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length ? n : null;
}
