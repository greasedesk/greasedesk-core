/**
 * File: lib/vehicle-lookup-client.ts
 * THE one client path for "reg → vehicle prefill", shared by every surface that offers a Look-up
 * button (New Job Card, diary quick-create, existing-card Customer Details). Previously each surface
 * hand-rolled its own fetch→map→setState and they had DRIFTED (one fired on blur and overwrote typed
 * values). This centralises the fetch + normalisation so there is a single implementation to reason
 * about.
 *
 * Order: OUR records first (/api/vehicle-lookup — a returning car brings owner + full vehicle), then
 * DVSA MOT History (/api/dvsa-lookup) for a new car. Best-effort and NON-THROWING: any network/API
 * failure resolves to { ok:false, reason } so the form stays fully usable for manual entry.
 *
 * It deliberately does NOT touch form state — but it DOES own the rules, as pure functions the
 * callers apply to their own inputs (applyLookup / staleAgainst / clearStale, below). That
 * distinction is the fix for a real bug: "the merge policy lives with the form" used to mean each
 * form hand-rolled it, three implementations drifted, and none of them handled the case where the
 * REGISTRATION ITSELF CHANGED. State stays with the form; the policy lives here, once.
 */
import type { OpenCardSummary } from '@/lib/duplicate-cards';
import type { DvsaFailure } from '@/lib/dvsa';
import type { RefreshOutcome } from '@/lib/mot-refresh';
// VALUE imports, and safe: lib/mot-refresh is pure and client-side already (the diary imports it).
import { motCheckReason, motLookupLine } from '@/lib/mot-refresh';
import { normalizeReg, sameRegistration } from '@/lib/vehicle-identity';

export type LookupVehicleFields = {
  make: string; model: string; colour: string; year: string; fuel: string; engineCc: string;
  vin: string; mileage: string;
};
export type LookupOwnerFields = { name: string; phone: string; email: string };
export type LookupMotMeta = { motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null };
/** What we ALREADY HOLD about this car's MOT — for display only. Never sent back on save: see the
 *  note in pages/api/vehicle-lookup for why our own record must not stamp mot_checked_at. */
export type StoredMot = { motExpiry: string | null; motCheckedAt: string | null; firstRegistered: string | null; year: number | null };

export type VehicleLookupResult =
  | { ok: true; reg: string; source: 'records' | 'dvsa'; vehicle: LookupVehicleFields; owner: LookupOwnerFields | null; mot: LookupMotMeta | null;
      /** Owner's missed bookings, present only on a records hit with history (null = none or unknown). */
      noShows?: { count: number; dates: string[] } | null;
      /** Open due items on this car (null = none, or a non-records hit). */
      dueItems?: Array<{ id: string; description: string; dueBasis: string; dueDate: string | null; dueMileage: number | null; customerResponse: string }> | null;
      /** Cards already open for this car — see lib/duplicate-cards for which statuses count.
       *  Empty array when there are none; absent only from the DVSA branch, which has no cards. */
      openCards?: OpenCardSummary[] | null;
      /** The car's own MOT record — records hits only. DISPLAY ONLY (see StoredMot). */
      storedMot?: StoredMot | null;
      /** OUR id for this car — records hits only, and a HANDLE rather than a value to display.
       *  It is what lets a caller ask DVSA about the car it has just found (refreshMotFromDvsa). */
      vehicleId?: string | null }
  | { ok: false; reg: string; reason: 'empty-reg' | 'not-found' | 'error';
      /** WHICH DVSA failure, when the server named one. Absent for our own refusals (empty reg) and
       *  for a records miss, neither of which involved DVSA at all. */
      dvsaReason?: DvsaFailure | 'empty_answer' | null };

const S = (v: unknown): string => (v == null ? '' : String(v));
const Snum = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Look a registration up for form pre-fill.
 * @param rawReg   the raw reg as typed; canonicalised internally (the returned `reg` is normalised).
 * @param opts.internal  default true — check OUR records first. Pass false where the record already
 *                       exists (the existing-card details form) so only DVSA is consulted.
 */
export async function lookupVehicleByReg(
  rawReg: string,
  opts: { internal?: boolean; vehicleId?: string | null } = {},
): Promise<VehicleLookupResult> {
  const reg = normalizeReg(rawReg) || '';
  if (!reg) return { ok: false, reg: '', reason: 'empty-reg' };
  const includeInternal = opts.internal !== false;
  try {
    // 1) OUR records — returning car → owner + full vehicle (incl. VIN/mileage).
    if (includeInternal) {
      const res = await fetch(`/api/vehicle-lookup?reg=${encodeURIComponent(reg)}`, { cache: 'no-store' });
      const data = res.ok ? await res.json() : { found: false };
      if (data?.found) {
        const v = data.vehicle || {}, o = data.owner || {};
        return {
          ok: true, reg, source: 'records',
          vehicle: {
            make: S(v.make), model: S(v.model), colour: S(v.colour), year: Snum(v.year),
            fuel: S(v.fuel), engineCc: Snum(v.engineCc), vin: S(v.vin), mileage: Snum(v.mileage),
          },
          owner: { name: S(o.name), phone: S(o.phone), email: S(o.email) },
          // Present only on a records hit with a resolved owner — a DVSA hit knows the car, not the
          // customer, and must not imply a clean history it never checked.
          noShows: data.noShows && data.noShows.count > 0 ? { count: Number(data.noShows.count), dates: (data.noShows.dates ?? []).map(S) } : null,
          // Open findings on this car — present only on a records hit (DVSA knows the car, not
          // what we found on it last March).
          dueItems: Array.isArray(data.dueItems) && data.dueItems.length ? data.dueItems : null,
          openCards: Array.isArray(data.openCards) ? data.openCards : null,
          mot: null,
          // A returning car used to arrive with NOTHING about its MOT, so a booking form could not
          // warn about the very cars it knows best. Display-only; see StoredMot.
          storedMot: (data.storedMot ?? null) as StoredMot | null,
          // And now it arrives with a HANDLE, so the caller can go and check that record rather
          // than only display it. See refreshMotFromDvsa below.
          vehicleId: typeof data.vehicleId === 'string' ? data.vehicleId : null,
        };
      }
    }
    // 2) New car → DVSA MOT History (make/model/colour/year/fuel/engine + MOT metadata). Best-effort:
    //    the endpoint always answers 200 with { found } so a lookup failure never blocks the form.
    // vehicleId, when the caller has one, lets the SERVER keep the MOT odometer history it just
    // fetched (lib/odometer). Absent on a first lookup — the car has no record to hang it on yet.
    const vq = opts.vehicleId ? `&vehicleId=${encodeURIComponent(opts.vehicleId)}` : '';
    const sres = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(reg)}${vq}`, { cache: 'no-store' });
    const d = sres.ok ? await sres.json() : { found: false };
    if (d?.found) {
      return {
        ok: true, reg, source: 'dvsa',
        vehicle: {
          make: S(d.make), model: S(d.model), colour: S(d.colour), year: Snum(d.year),
          fuel: S(d.fuel), engineCc: Snum(d.engineCc), vin: '', mileage: '',
        },
        owner: null,
        mot: { motExpiry: d.motExpiry ?? null, lastMotMileage: d.lastMotMileage ?? null, lastMotDate: d.lastMotDate ?? null },
      };
    }
    // NOT-FOUND CARRIES THE SERVER'S DIAGNOSIS. The endpoint answers 200 { found:false, reason }
    // for every DVSA failure, so `not-found` here is still "no prefill" — but the caller can now
    // say WHICH, and a rate-limited key no longer reads to the operator as an unknown plate.
    return { ok: false, reg, reason: 'not-found', dvsaReason: d?.reason ?? null };
  } catch {
    return { ok: false, reg, reason: 'error', dvsaReason: null }; // network/parse — "enter manually"
  }
}

/**
 * ASK DVSA ABOUT A CAR WE ALREADY HOLD, AND SAY WHAT CAME BACK.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────────
 * lookupVehicleByReg checks OUR RECORDS FIRST and returns the moment they answer — correctly, since
 * a returning car brings its owner and its whole history with it, and DVSA knows neither. The cost
 * was that a known car's MOT was whatever we last happened to store. LC09XFU showed a booking form
 * "MOT expired 2026-07-23" for a car that had been tested since, and pressing Look up again could
 * not help: the records branch never reaches DVSA, by design.
 *
 * So the fix is not to reorder the lookup — that would throw away the owner on every returning car
 * to re-learn a make and model we already have. It is a SECOND, CONDITIONAL call, made only when
 * what we hold has stopped being evidence about today (lib/mot-refresh::motCheckReason).
 *
 * ── IT GOES THROUGH THE EXISTING ENDPOINT, NOT A NEW ONE ────────────────────────────────────────
 * /api/mot-refresh already does exactly this and does three things a new path would have had to
 * re-learn: motFieldsToWrite (refresh-don't-fill, an earlier expiry overwrites, an absence never
 * erases), the odometer history that the mileage rate depends on, and the rule that a lookup which
 * failed stamps NOTHING — not the fields and not mot_checked_at. Its reply is already shaped for a
 * surface to render.
 *
 * ── NON-THROWING, AND IT NEVER REPORTS A CHECK IT DID NOT GET ───────────────────────────────────
 * A thrown fetch comes back as `no_answer` with its own sentence, so the caller has ONE shape to
 * handle — but `checkedAt` is null for both silences, and a caller that stamps a banner from it
 * cannot claim a verification that did not happen. The two silences are told apart in the words
 * because they are fixed differently: DVSA not answering is theirs, a fetch not completing is ours.
 */
export type MotRefreshReply = {
  outcome: RefreshOutcome;
  checkedAt: string | null;
  /**
   * THE SPEC FIELDS OFF THE SAME ANSWER — null when the check did not answer.
   *
   * One call, both uses. The response the MOT came from already carried make, model, colour, fuel,
   * engine and year, and the endpoint used to drop them: a car with a thin record and a fresh MOT
   * stamp could be looked up every day and stay thin for ever. These fill the form's BLANKS only
   * (applyLookup) and are not saved to the vehicle — see the endpoint for why that write is a
   * separate decision.
   */
  vehicle: Partial<Record<'make' | 'model' | 'colour' | 'fuel' | 'year' | 'engineCc', string>> | null;
};

export async function refreshMotFromDvsa(vehicleId: string): Promise<MotRefreshReply> {
  const silent = (sentence: string, failure: DvsaFailure | null = null): MotRefreshReply => ({
    // stillDue:true because nothing was learned, which cannot have moved the band — the same
    // reading lib/mot-refresh takes for its own no_answer.
    outcome: { kind: 'no_answer', failure, sentence, expiry: null, stillDue: true },
    checkedAt: null,
    vehicle: null,
  });
  try {
    const r = await fetch('/api/mot-refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId }), cache: 'no-store',
    });
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (!j?.outcome) return silent('The check didn’t complete — nothing was learned.');
    return {
      outcome: j.outcome as RefreshOutcome,
      checkedAt: typeof j.checkedAt === 'string' ? j.checkedAt : null,
      // ONLY OFF AN ANSWER. checkedAt is null for both silences and the endpoint sends no vehicle
      // with either, but this is belt-and-braces: a form must never fill a field from a check that
      // did not happen, and that rule is cheaper to enforce here than to remember at each caller.
      vehicle: j.checkedAt && j.vehicle ? specStrings(j.vehicle) : null,
    };
  } catch {
    return silent('The check didn’t complete — nothing was learned.');
  }
}

/** The endpoint sends year/engineCc as numbers; applyLookup merges strings. Nulls are dropped, not
 *  stringified — "null" in a form field is worse than an empty one. */
function specStrings(v: Record<string, unknown>): MotRefreshReply['vehicle'] {
  const out: Record<string, string> = {};
  for (const k of ['make', 'model', 'colour', 'fuel', 'year', 'engineCc'] as const) {
    const raw = v[k];
    if (raw == null || raw === '') continue;
    out[k] = String(raw);
  }
  return out;
}

/**
 * WHAT THE RECORD BECOMES AFTER A CHECK — and it is a function here for the reason the rest of this
 * module's policy is: state stays with the form, the rule lives in one place.
 *
 * Inline in the surface it was three lines of `setState` that no test could reach without a browser,
 * and the three lines carried the only rule that matters: ONLY AN ANSWER CHANGES ANYTHING. Both
 * silences — DVSA not answering, and the fetch not completing — carry `checkedAt: null`, and the
 * record must come back BYTE-IDENTICAL, so the banner above it says exactly what it said before.
 * Writing a local clock here instead would make the screen claim a verification nobody performed,
 * on the screen where somebody is deciding whether a car may legally be driven to them.
 *
 * `firstRegistered` and `year` are carried through untouched: they came from our own record, the
 * refresh says nothing about them, and losing them would change the banner's reading of a car with
 * no MOT (lib/mot-banner tells a probably-new car from an unknown one by exactly those two fields).
 */
export function applyMotRefresh(prev: StoredMot | null, reply: MotRefreshReply): StoredMot | null {
  if (!reply.checkedAt) return prev;
  return {
    motExpiry: reply.outcome.expiry,
    motCheckedAt: reply.checkedAt,
    firstRegistered: prev?.firstRegistered ?? null,
    year: prev?.year ?? null,
  };
}

// ── THE MERGE POLICY, AND WHEN AN ANSWER STOPS BEING THIS CAR'S ─────────────────────────────────
/**
 * WHAT A LOOKUP FILLED, AND WHICH PLATE IT CAME FROM.
 *
 * Fill-blanks-only was written for pressing Look up TWICE ON THE SAME CAR, where clobbering a
 * manual correction would be wrong. It is right for that and was never extended to the case where
 * the registration changed — which is not a re-fetch of the same car, it is a different car. So a
 * fill remembers its plate, and the form asks whether that plate is still the one in the box.
 */
export type LookupFill = {
  /** NORMALISED. Compared through sameRegistration, so tidying the spacing is not a change. */
  reg: string;
  /** ONLY the fields this lookup actually wrote, and the exact value it wrote. */
  fields: Record<string, string>;
  /** Whether the answer carried MOT metadata, which has no manual input and is wholly lookup-owned. */
  mot: boolean;
};

/**
 * FILL BLANKS ONLY, and record what was filled. The three forms had three copies of this — two
 * spelled `!x.trim() &&`, one spelled `keep(p.x, …)` — and a rule with three implementations is
 * three rules. Values are compared and written as strings because that is what an input holds.
 */
/**
 * ── IS WHAT WE HOLD ABOUT THIS CAR WORTH ASKING DVSA FOR? ───────────────────────────────────────
 * The second half of the LC09XFU report, and a different question from the MOT's. That car came
 * back "Filled from your records" with make MINI, model MINI, and colour, year, fuel, engine and
 * VIN all empty — a records hit so thin it filled almost nothing, and the records branch never
 * reaches DVSA to do better. Measured on production the same afternoon: 101 of 369 real-tenant
 * cars, 27%, are missing at least one field DVSA could have supplied.
 *
 * VIN IS DELIBERATELY NOT IN THIS LIST, although it is the commonest blank at 97 cars. DvsaVehicle
 * carries no VIN, so including it would call DVSA for 26% of the fleet and fill nothing — a lookup
 * that can only fail, on a shared key. A field belongs here when an answer could fill it.
 */
export const DVSA_FILLABLE = ['make', 'model', 'colour', 'fuel', 'year', 'engineCc'] as const;
export type DvsaFillable = (typeof DVSA_FILLABLE)[number];

/**
 * A MODEL THAT MERELY REPEATS THE MAKE IS NOT A MODEL.
 *
 * 58 of TMBS's cars hold model == make — 57 of them "MINI"/"MINI" — which is what an import does
 * when it has one name and two columns to put it in. The column is not empty, so every blanks-only
 * merge ever written has skipped it, which is why those 58 have survived every look-up to date.
 *
 * Case- and space-insensitive, and that is the whole test. It does NOT attempt to judge whether a
 * make is wrong: one car holds make "Cooper", model "Cooper", where Cooper is a model and the MAKE
 * is the incorrect field. Filling blanks cannot fix that and must not pretend to — this is a rule
 * about a value that says nothing, not a data-quality pass.
 */
export function modelEchoesMake(make: string | null | undefined, model: string | null | undefined): boolean {
  const a = String(make ?? '').trim().toUpperCase();
  const b = String(model ?? '').trim().toUpperCase();
  return !!a && !!b && a === b;
}

/**
 * The fields a merge may OVERWRITE on this record, as opposed to fill. Exactly one rule feeds it
 * today, and it returns a list rather than a boolean so a second rule has somewhere to go that is
 * not another parameter at every call site.
 */
export function echoedKeys(current: { make?: string | null; model?: string | null }): DvsaFillable[] {
  return modelEchoesMake(current.make, current.model) ? ['model'] : [];
}

/**
 * Would a DVSA answer tell us anything we do not already hold? Blank, or a model echoing the make.
 *
 * Paired with motCheckReason by the caller, never folded into it: `stale` is about how old our
 * evidence is and `thin` is about how much of it there is, and a car can be either without being
 * both. One DVSA call answers both questions — see the diary, where the condition is `stale || thin`
 * and a single reply feeds the MOT fields and the blank fill.
 */
export function isThinRecord(v: Partial<Record<DvsaFillable, string | number | null | undefined>>): boolean {
  if (DVSA_FILLABLE.some((k) => !String(v[k] ?? '').trim())) return true;
  return modelEchoesMake(v.make as string, v.model as string);
}

export function applyLookup<T extends Record<string, string>>(
  current: T,
  incoming: Partial<Record<keyof T & string, string | null | undefined>>,
  reg: string,
  opts: { mot?: boolean; overwritable?: readonly string[] } = {},
): { values: T; fill: LookupFill } {
  const values = { ...current };
  const fields: Record<string, string> = {};
  /**
   * THE NARROW EXCEPTION TO "NEVER CLOBBERED", and the order of the two guards below is the whole
   * of its safety. `overwritable` names fields whose stored value says nothing — today only a model
   * echoing the make (echoedKeys). It is a licence to REPLACE, never a licence to CLEAR: the
   * "nothing offered" guard runs FIRST and unconditionally, so a field on this list keeps what it
   * had whenever DVSA sends nothing for it. That is what makes it impossible for this to leave the
   * form worse than it found it, which is the property the ruling asked for by name.
   */
  const over = new Set(opts.overwritable ?? []);
  for (const [k, raw] of Object.entries(incoming)) {
    const next = typeof raw === 'string' ? raw : '';
    if (!next.trim()) continue;                             // nothing offered — leave it alone
    if (String(values[k] ?? '').trim() && !over.has(k)) continue; // something there — never clobbered
    if (String(values[k] ?? '').trim() === next.trim()) continue; // identical: not a fill, not a change
    (values as Record<string, string>)[k] = next;
    fields[k] = next;                                 // remembered so it can be taken back
  }
  return { values, fill: { reg: normalizeReg(reg) ?? '', fields, mot: !!opts.mot } };
}

/**
 * ── THE WHOLE LOOK-UP, ONCE, FOR EVERY SURFACE THAT HAS A REGISTRATION BOX ──────────────────────
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The MOT refresh and the blank fill were built on the DIARY's quick-create and nowhere else, and
 * the report came back from the NEW JOB CARD page: LC09XFU, S1CNE, L100BKY and KW21HLN all said
 * "Filled from your records" and nothing more — S1CNE's make, model, colour, year, fuel and engine
 * stayed blank, L100BKY stayed MINI/MINI, and no MOT line appeared on any of them. Every one of
 * those is the defect that had just been fixed, on a surface that never got the fix.
 *
 * Three surfaces call lookupVehicleByReg — the diary, pages/admin/jobcards/new, and the existing
 * card's Customer Details pane — and each held its OWN copy of what to do with the answer. That is
 * the same shape of failure this module's header already describes ("three implementations drifted,
 * and none of them handled the case where the REGISTRATION ITSELF CHANGED"); the fix then was to
 * move the merge here, and the merge is now only part of the policy. The rest of it — records
 * first, then DVSA for the gaps, and always a line about the MOT — went back to living in a page.
 *
 * So the POLICY lives here, entire:
 *   1. our records first, because a returning car brings its owner, its history and its open cards;
 *   2. then DVSA, when what we hold is stale OR thin, as ONE call serving both questions;
 *   3. blanks only, never overwriting what is stored or typed, with a model that merely repeats the
 *      make counted as blank (echoedKeys) and never cleared if DVSA offers nothing;
 *   4. a line about the MOT, ALWAYS — including the press that makes no call at all.
 *
 * ── WHAT IS DELIBERATELY NOT SHARED ─────────────────────────────────────────────────────────────
 * The STATE and the WORDING. Callers set their own fields from `values` and word their own status
 * message from `source`, because the diary is translated through next-i18next and the new-card page
 * is not, and folding that in here would either hardcode English into a shared module or silently
 * drop a translation. `motLine` IS returned ready to print: the sentence is the feature and
 * lib/mot-refresh owns it, so no surface composes a second version. (That line is not yet
 * translated — the i18n debt is noted there and on both surfaces.)
 *
 * The one field whose NAME differs between surfaces is the customer's: `cust` on the diary,
 * `customerName` on the new-card page. Named by the caller rather than guessed at, and omitted
 * entirely by the existing-card pane, which owns its customer elsewhere.
 */
export type LookupAndFillOptions = {
  /** OUR id for this car, when the caller has one — the handle /api/mot-refresh needs. */
  vehicleId?: string | null;
  /** default true — check our records first. False goes straight to DVSA (the existing-card pane,
   *  where the record IS the form and re-reading it would tell us nothing new). */
  internal?: boolean;
  /** Which key in the caller's form holds the customer's name. Omit to fill no owner fields. */
  ownerNameKey?: string;
  /** Injectable for the gate; defaults to the wall clock. */
  now?: Date;
};

export type LookupAndFillResult<T> =
  | { ok: false; reg: string; reason: 'empty-reg' | 'not-found' | 'error';
      dvsaReason: DvsaFailure | 'empty_answer' | null; motLine: null }
  | { ok: true; reg: string; source: 'records' | 'dvsa';
      /** The caller's own object with the blanks filled — every other key untouched. */
      values: T;
      fill: LookupFill;
      /** What we now hold about the MOT, after any refresh. Null on a DVSA-branch hit. */
      storedMot: StoredMot | null;
      /** DVSA's own MOT facts, for the caller to send on save. */
      mot: LookupMotMeta | null;
      owner: LookupOwnerFields | null;
      noShows: { count: number; dates: string[] } | null;
      dueItems: NonNullable<Extract<VehicleLookupResult, { ok: true }>['dueItems']> | null;
      openCards: OpenCardSummary[] | null;
      /** THE LINE, ready to print. Never null on a hit — that is the point of it. */
      motLine: string;
      /** Did this press reach DVSA? For the gate, and for a caller that wants to say so. */
      dvsaCalled: boolean;
      /** Which failure, if the refresh ran and did not answer. */
      refreshFailure: DvsaFailure | null };

export async function lookupAndFill<T extends Record<string, any>>(
  rawReg: string,
  current: T,
  opts: LookupAndFillOptions = {},
): Promise<LookupAndFillResult<T>> {
  const now = opts.now ?? new Date();
  const r = await lookupVehicleByReg(rawReg, { internal: opts.internal, vehicleId: opts.vehicleId });
  if (!r.ok) return { ok: false, reg: r.reg, reason: r.reason, dvsaReason: r.dvsaReason ?? null, motLine: null };

  // ── 1. THE PREFILL, BLANKS ONLY ───────────────────────────────────────────────────────────────
  const incoming: Record<string, string | null | undefined> = {
    vin: r.vehicle.vin, mileage: r.vehicle.mileage, make: r.vehicle.make, model: r.vehicle.model,
    colour: r.vehicle.colour, fuel: r.vehicle.fuel, year: r.vehicle.year, engineCc: r.vehicle.engineCc,
  };
  // THE OWNER ONLY WHEN THE CALLER HAS SOMEWHERE TO PUT IT. A records hit brings the customer; a
  // DVSA hit knows the car and not the customer, and r.owner is null there, so this is naturally
  // empty rather than guarded on the source.
  if (opts.ownerNameKey && r.owner) {
    incoming[opts.ownerNameKey] = r.owner.name;
    incoming.phone = r.owner.phone;
    incoming.email = r.owner.email;
  }
  const first = applyLookup(current as Record<string, string>, incoming, r.reg,
    { mot: !!r.mot, overwritable: echoedKeys({ make: current.make, model: current.model }) });
  let values = first.values as unknown as T;
  let fill = first.fill;

  // ── 2. AND IF WHAT WE HOLD IS STALE OR THIN, ONE CALL TO DVSA ─────────────────────────────────
  // Only on a records hit: the DVSA branch has just been to DVSA. The condition is the throttle —
  // one shared key, no cache, no cap of ours — so a car that is fresh AND fully filled costs
  // nothing, and the same car pressed four times in an afternoon costs one call.
  let storedMot: StoredMot | null = r.source === 'records' ? (r.storedMot ?? null) : null;
  let refreshFailure: DvsaFailure | null = null;
  let dvsaCalled = r.source === 'dvsa';

  if (r.source === 'records') {
    const stale = motCheckReason({ motCheckedAt: storedMot?.motCheckedAt ?? null }, now);
    // THIN IS ASKED OF THE MERGED VALUES, not of the stored record: anything the operator has
    // already typed is not a gap, and filling it is not a reason to spend a call.
    const thin = isThinRecord({ make: values.make, model: values.model, colour: values.colour,
      fuel: values.fuel, year: values.year, engineCc: values.engineCc });
    if (r.vehicleId && (stale || thin)) {
      dvsaCalled = true;
      const reply = await refreshMotFromDvsa(r.vehicleId);
      storedMot = applyMotRefresh(storedMot, reply);
      refreshFailure = reply.outcome.failure;
      if (reply.vehicle) {
        const second = applyLookup(values as Record<string, string>, reply.vehicle, r.reg,
          { mot: fill.mot, overwritable: echoedKeys({ make: values.make, model: values.model }) });
        values = second.values as unknown as T;
        // BOTH FILLS, MERGED. Keeping only the second would forget what the records merge filled,
        // and clearStale would then leave those fields behind when the plate changed.
        fill = { ...fill, fields: { ...fill.fields, ...second.fill.fields } };
      }
    }
  }

  // ── 3. THE LINE, ALWAYS ───────────────────────────────────────────────────────────────────────
  // A DVSA-branch hit has just been answered, so the stamp is now and the expiry is theirs. A
  // records hit speaks from what we hold, which is what lets it say something on the press that
  // made no call — the LC09XFU case, where two correct silences produced a blank screen.
  const motLine = r.source === 'dvsa'
    ? motLookupLine({ expiry: r.mot?.motExpiry ?? null, checkedAt: now, failure: null, now })
    : motLookupLine({ expiry: storedMot?.motExpiry ?? null, checkedAt: storedMot?.motCheckedAt ?? null, failure: refreshFailure, now });

  return {
    ok: true, reg: r.reg, source: r.source, values, fill, storedMot, mot: r.mot ?? null,
    owner: r.owner ?? null, noShows: r.noShows ?? null, dueItems: r.dueItems ?? null,
    openCards: r.openCards ?? null, motLine, dvsaCalled, refreshFailure,
  };
}

/** Has the plate moved away from the one this fill came from? No fill = nothing to be stale. */
export function staleAgainst(fill: LookupFill | null | undefined, reg: string): boolean {
  if (!fill) return false;
  return !sameRegistration(fill.reg, reg);
}

/**
 * TAKE BACK WHAT THE LOOKUP GAVE, AND ONLY THAT.
 *
 * A field is cleared if it STILL HOLDS what the lookup wrote. A value the operator has since
 * changed is provably theirs and survives, and a field the lookup never wrote is never touched —
 * which is what stops this blanking a real car on the details pane, where make/model/colour are
 * seeded from the SAVED vehicle and no lookup put them there.
 *
 * The one residual error is a value the operator typed that happens to equal what the lookup wrote:
 * indistinguishable, and cleared. That costs a retype. The opposite error — keeping another car's
 * data — is silent and reaches the database. The asymmetry is the whole argument for clearing.
 *
 * MOT is unconditional: no form offers a manual MOT input, so every byte of it is lookup-owned.
 */
export function clearStale<T extends Record<string, string>>(
  current: T,
  fill: LookupFill | null | undefined,
): { values: T; cleared: string[]; clearMot: boolean } {
  if (!fill) return { values: current, cleared: [], clearMot: false };
  const values = { ...current };
  const cleared: string[] = [];
  for (const [k, written] of Object.entries(fill.fields)) {
    if (String(values[k] ?? '') !== written) continue; // theirs now
    (values as Record<string, string>)[k] = '';
    cleared.push(k);
  }
  return { values, cleared, clearMot: fill.mot };
}

/**
 * VIN → vehicle prefill (US / NHTSA vPIC), the sibling of lookupVehicleByReg and held to the same
 * contract: NON-THROWING, fill-blanks-only at the caller, and honest about what a VIN cannot say
 * (colour, mileage, plate and inspection history come back empty — never invented).
 */
export type VinLookupResult =
  | { ok: true; vin: string; source: 'vpic'; vehicle: LookupVehicleFields; spec: { trim: string; bodyClass: string; cylinders: string; drive: string } }
  | { ok: false; vin: string; reason: 'empty-vin' | 'invalid-vin' | 'not-found' | 'no-provider' | 'error' };

export async function lookupVehicleByVin(rawVin: string): Promise<VinLookupResult> {
  const vin = String(rawVin ?? '').trim().toUpperCase();
  if (!vin) return { ok: false, vin, reason: 'empty-vin' };
  try {
    const r = await fetch(`/api/vin-lookup?vin=${encodeURIComponent(vin)}`);
    if (!r.ok) return { ok: false, vin, reason: 'error' };
    const d = await r.json();
    if (!d?.found) return { ok: false, vin, reason: (d?.reason ?? 'not-found') as VinLookupResult extends { ok: false } ? any : any };
    return {
      ok: true, vin: d.vin ?? vin, source: 'vpic',
      vehicle: {
        make: S(d.vehicle?.make), model: S(d.vehicle?.model), colour: '', year: Snum(d.vehicle?.year),
        fuel: S(d.vehicle?.fuel), engineCc: Snum(d.vehicle?.engineCc), vin: d.vin ?? vin, mileage: '',
      },
      spec: { trim: S(d.spec?.trim), bodyClass: S(d.spec?.bodyClass), cylinders: S(d.spec?.cylinders), drive: S(d.spec?.drive) },
    };
  } catch {
    return { ok: false, vin, reason: 'error' };
  }
}

/**
 * FETCH THE DVSA ODOMETER HISTORY FOR A CAR WE HAVE JUST CREATED.
 *
 * ── THE DEFERRAL THAT NEVER RESOLVED ────────────────────────────────────────────────────────────
 * /api/dvsa-lookup keeps the MOT odometer history only when the caller names a vehicle we own —
 * reasonably, since a first lookup on an unknown reg has nothing to attach it to. Its comment says
 * "the readings land on the next lookup once the record exists".
 *
 * They never did. The only caller that passed a vehicleId was the job card's manual look-up button,
 * which a garage that books through the diary never presses. Measured 2026-08-19 on 221 real cars:
 * ZERO MOT-sourced odometer readings, for any vehicle, ever. Every reading in the database was a
 * mileage typed at a visit, and only 30 of TMBS's 221 cars had the two readings a rate needs.
 * (Both figures are from BEFORE the backfill; after it, 192 of 221 carry a rate.)
 *
 * That is not a small gap. The rate feeds the servicing list's dated band, the tyre wear rate and
 * the battery decline projection — all three were running on 14% of the fleet.
 *
 * So the deferral is resolved HERE, by the creating surface, the moment the vehicle exists.
 *
 * BEST-EFFORT AND FIRE-AND-FORGET: it must never delay or fail a booking. A car with no DVSA
 * history simply stores nothing, which is the same outcome as before.
 */
export function backfillMotHistory(registration: string, vehicleId: string | null | undefined): void {
  if (!registration || !vehicleId) return;
  void fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(registration)}&vehicleId=${encodeURIComponent(vehicleId)}`,
    { cache: 'no-store' }).catch(() => {});
}
