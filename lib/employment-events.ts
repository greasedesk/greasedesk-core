/**
 * File: lib/employment-events.ts
 * THE dual-write chokepoint for employment history (record-first). Editing a current value
 * writes the flat CostPerson column AND appends the dated event IN ONE TRANSACTION — both
 * commit or neither; history and current-state must never drift. The flat column stays the
 * HEAD of every series (capacity/P&L/roster keep reading it this build); the banked
 * value-true-at-time follow-on reads "latest event of kind K with effective_date ≤ T"
 * (created_at breaks ties) and falls back to the column — see the schema comment for what a
 * back-dated-before-existing event means (it inserts history, never moves the head).
 */
import { Prisma } from '@prisma/client';

export type EmploymentShape = {
  name: string;
  role: string | null;
  amount_pennies: number;
  cost_type: string;
  is_chargeable: boolean;
  contracted_hours_per_day: number | null;
  working_days: number[];
  annual_leave_allowance_days: number | null;
  start_date: Date | null;
  utilisation_factor: number;
};

export type EmploymentChange = { kind: string; value: unknown; previous: unknown };

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const sameArr = (a: number[], b: number[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** PURE diff of the tracked field-families (one event per changed kind). */
export function diffEmploymentShape(current: EmploymentShape, next: EmploymentShape): EmploymentChange[] {
  const out: EmploymentChange[] = [];
  if (current.name !== next.name) {
    out.push({ kind: 'name', value: { name: next.name }, previous: { name: current.name } });
  }
  if ((current.role ?? null) !== (next.role ?? null)) {
    out.push({ kind: 'role', value: { role: next.role }, previous: { role: current.role } });
  }
  if (current.amount_pennies !== next.amount_pennies || current.cost_type !== next.cost_type) {
    out.push({ kind: 'wage', value: { amount_pennies: next.amount_pennies, cost_type: next.cost_type }, previous: { amount_pennies: current.amount_pennies, cost_type: current.cost_type } });
  }
  if ((current.contracted_hours_per_day ?? null) !== (next.contracted_hours_per_day ?? null)) {
    out.push({ kind: 'hours', value: { contracted_hours_per_day: next.contracted_hours_per_day }, previous: { contracted_hours_per_day: current.contracted_hours_per_day } });
  }
  if (!sameArr(current.working_days, next.working_days)) {
    out.push({ kind: 'pattern', value: { working_days: [...next.working_days].sort() }, previous: { working_days: [...current.working_days].sort() } });
  }
  if (current.is_chargeable !== next.is_chargeable) {
    out.push({ kind: 'chargeable', value: { is_chargeable: next.is_chargeable }, previous: { is_chargeable: current.is_chargeable } });
  }
  if ((current.annual_leave_allowance_days ?? null) !== (next.annual_leave_allowance_days ?? null)) {
    out.push({ kind: 'allowance', value: { annual_leave_allowance_days: next.annual_leave_allowance_days }, previous: { annual_leave_allowance_days: current.annual_leave_allowance_days } });
  }
  if (day(current.start_date) !== day(next.start_date)) {
    out.push({ kind: 'started', value: { start_date: day(next.start_date) }, previous: { start_date: day(current.start_date) } });
  }
  if (current.utilisation_factor !== next.utilisation_factor) {
    out.push({ kind: 'factor', value: { utilisation_factor: next.utilisation_factor }, previous: { utilisation_factor: current.utilisation_factor } });
  }
  return out;
}

/** Append events inside the caller's transaction (the caller updates the flat columns in the
 *  SAME tx — that pairing is the dual-write invariant). */
export async function recordEmploymentEvents(
  tx: Prisma.TransactionClient,
  args: { groupId: string; costPersonId: string; changedBy: string | null; effectiveDate: Date; changes: EmploymentChange[] },
): Promise<void> {
  if (!args.changes.length) return;
  await tx.employmentEvent.createMany({
    data: args.changes.map((c) => ({
      group_id: args.groupId, cost_person_id: args.costPersonId, kind: c.kind as any,
      effective_date: args.effectiveDate, value_json: c.value as any, previous_json: c.previous as any,
      changed_by: args.changedBy,
    })),
  });
}

/** Backdate/postdate confirm guard (PURE): effective dates more than a year either side of
 *  today need an explicit confirm — never accepted silently. */
export function datedConfirmNeeded(effective: Date, today: Date): boolean {
  return Math.abs(effective.getTime() - today.getTime()) > 366 * 86_400_000;
}

// ---- Corrections (admin-only; the correction is ITSELF recorded — the trail stays honest) ----
/** Redate a mis-dated event IN PLACE: effective_date moves, and {at, by, from, to} appends to
 *  correction_json (an array — repeat corrections stack). No duplicate event is created. */
export async function redateEvent(
  tx: Prisma.TransactionClient,
  args: { groupId: string; eventId: string; newEffectiveDate: Date; by: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const ev = (await tx.employmentEvent.findFirst({
    where: { id: args.eventId, group_id: args.groupId },
    select: { id: true, effective_date: true, correction_json: true, voided_at: true },
  })) as any;
  if (!ev) return { ok: false, error: 'notFound' };
  if (ev.voided_at) return { ok: false, error: 'voided' };
  const from = ev.effective_date.toISOString().slice(0, 10);
  const to = args.newEffectiveDate.toISOString().slice(0, 10);
  if (from === to) return { ok: false, error: 'unchanged' };
  const log = Array.isArray(ev.correction_json) ? ev.correction_json : [];
  await tx.employmentEvent.update({
    where: { id: ev.id },
    data: {
      effective_date: args.newEffectiveDate,
      correction_json: [...log, { at: new Date().toISOString(), by: args.by, from, to }] as any,
    },
  });
  return { ok: true };
}

/** Void a mistaken event: stays visible (struck through) but EXCLUDED from any value-at-time
 *  read (the ordering rule reads "latest NON-VOIDED event of kind K ≤ T"). Idempotence guarded. */
export async function voidEvent(
  tx: Prisma.TransactionClient,
  args: { groupId: string; eventId: string; by: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const ev = (await tx.employmentEvent.findFirst({
    where: { id: args.eventId, group_id: args.groupId },
    select: { id: true, voided_at: true },
  })) as any;
  if (!ev) return { ok: false, error: 'notFound' };
  if (ev.voided_at) return { ok: false, error: 'voided' };
  await tx.employmentEvent.update({ where: { id: ev.id }, data: { voided_at: new Date(), voided_by: args.by } });
  return { ok: true };
}
