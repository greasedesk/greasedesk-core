/**
 * File: pages/api/service-schedule.ts
 * POST { jobCardId, stage: 'arrival' | 'departure', entries } — the service computer, transcribed.
 *
 * ── TWO READINGS, TWO DESTINATIONS, AND THE STAGE IS DECLARED ───────────────────────────────────
 * The computer is read twice in a visit and the readings mean different things:
 *
 *   arrival    what was due when the car came in. A fact about a VISIT → ServiceScheduleReading.
 *              Never printed: the customer's invoice says what the car needs NEXT, not what it
 *              needed before we did the work.
 *   departure  what the car needs now, after the indicator was reset and the pads went on. A fact
 *              about a CAR → VehicleDueItem, and the only one the invoice reads.
 *
 * The stage is a required parameter rather than something inferred from which tab called. A caller
 * that has not said which reading it is holding does not know, and guessing would put an arrival
 * figure on a customer's document as though it were what happens next.
 *
 * OPERATIONAL authority. One transaction: the whole schedule lands, or none of it does — a garage
 * reading half a schedule back would not know which half.
 *
 * ── REPLAY-SAFE WITH NO CLIENT ID, LIKE EVERYTHING ELSE THAT HAS A NATURAL KEY ──────────────────
 * (group, vehicle, observation_key) is unique WHILE OPEN, so re-sending the same schedule updates
 * the same rows. A schedule is a CURRENT STATE, not a log: recording it again next visit should
 * correct it, and that is what the constraint already makes happen.
 *
 * ── A BLANK ROW CLEARS, IT DOES NOT SKIP ────────────────────────────────────────────────────────
 * Emptying a row the garage previously recorded is a statement — that item is no longer scheduled —
 * so the open item is CLOSED rather than left standing. Anything else would make a wrong date
 * impossible to retract, which is the sort of thing people work around by typing 1970 into a field.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { refuseBayWrite, bayWriteCard, BAY_WRITE_SELECT } from '@/lib/bay-write';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { scheduleByKey, refuseSchedule, isBlank, classifyEntry, resolveCountdown, SKIPPED_BLANK_REASON, monthToStoredDate, legsFor, type ScheduleEntry, type ScheduleItem } from '@/lib/service-schedule';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { jobCardId, stage, entries } = (req.body || {}) as
    { jobCardId?: string; stage?: 'arrival' | 'departure'; entries?: ScheduleEntry[] };
  if (!jobCardId || !Array.isArray(entries)) return res.status(400).json({ message: 'A job card and its schedule are required.' });
  if (stage !== 'arrival' && stage !== 'departure') {
    return res.status(400).json({ message: 'Say whether this is the arrival or the departure reading.' });
  }
  for (const e of entries) {
    if (!scheduleByKey(String(e?.key))) return res.status(400).json({ message: 'Unknown schedule item.' });
  }
  // Paired with their catalogue entry, because the DECLARED basis is what decides which legs a row
  // needs — the payload no longer implies it.
  const paired = entries.map((e) => ({ ...e, item: scheduleByKey(String(e.key)) as ScheduleItem }));

  // THE CARD IS LOADED BEFORE THE PAYLOAD IS JUDGED, because a countdown cannot be judged without
  // the reading it counts from. refuseSchedule used to run first; it now runs on RESOLVED entries,
  // so "the mileage leg is missing" is asked of the derived target rather than of the units the
  // garage happened to type it in.
  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: { id: true, site_id: true, vehicle_id: true, odometer_in: true, odometer_out: true, ...BAY_WRITE_SELECT },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  // ── A FINISHED JOB TAKES NO NEW BAY DATA ────────────────────────────────────────────────────
  // One predicate, seven writers. See lib/bay-write: the invoice freeze is the boundary and the
  // admin unlock is the way back, because both already exist and both are already audited.
  const bayRefusal = refuseBayWrite(bayWriteCard(card as never));
  if (bayRefusal) return res.status(409).json({ message: bayRefusal.message, code: bayRefusal.code });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  // ── COUNTDOWN → TARGET, ONCE, ON THE SERVER ───────────────────────────────────────────────────
  // The client shows its arithmetic so a mis-keyed odometer is caught at the car, but it does not
  // get to BE the arithmetic: the stored countdown and the stored target have to agree, and the
  // only way to guarantee that is for one side to derive the other. Counted from the reading for
  // THIS stage — arrival from what came in, departure from what goes out.
  const odometer = stage === 'arrival' ? card.odometer_in : card.odometer_out;
  for (const e of paired) {
    if (e.countdownMiles == null) continue;
    const r = resolveCountdown(Number(e.countdownMiles), odometer, stage);
    if (!r.ok) {
      // ── "NOT YET" IS NOT "NOT EVER" ─────────────────────────────────────────────────────────
      // 400 is in the service worker's TERMINAL_STATUSES: a queued item that gets one is DELETED,
      // not retried. A phone can legitimately queue a countdown before its own mileage write has
      // drained, and answering that with 400 would destroy a reading a mechanic took — the exact
      // failure this whole area has spent the week closing. A missing odometer is a 409: the card
      // is not in a state to accept this yet, and it will be. A countdown that lands before zero
      // is a bad payload and stays 400, because retrying it changes nothing.
      const status = r.code === 'no_odometer' ? 409 : 400;
      return res.status(status).json({ message: r.message, refusals: [{ key: e.key, code: r.code, message: r.message }] });
    }
    e.dueMileage = r.dueMileage;   // whatever the client put here is replaced, never merged
  }

  // ── THE MODE IS THIS FUNCTION'S ACCOUNT OF WHAT IT DID ──────────────────────────────────────
  // Derived from the payload AFTER resolution, never read off the request. A client claiming
  // `target` while sending a countdown gets `countdown` stored, for the same reason its target was
  // replaced above: the three columns describe one act and must not be able to disagree.
  //
  // Only rows with a mileage leg get a mode at all — a date-only row was not transcribed under
  // either convention, and stamping one would invent a fact. Null means "not written by the
  // schedule form", which is also what every row predating the column means.
  const modeFor = (e: ScheduleEntry & { item: ScheduleItem }): 'target' | 'countdown' | null => {
    if (!legsFor(e.item.basis).mileage) return null;
    if (e.countdownMiles != null) return 'countdown';
    return e.dueMileage != null ? 'target' : null;
  };

  const refusals = refuseSchedule(paired);
  if (refusals.length) return res.status(400).json({ message: refusals[0].message, refusals });

  // ── ARRIVAL: A VISIT MEASUREMENT ─────────────────────────────────────────────────────────────
  // Its own table, like a tyre depth or a battery test, and never a due item. Blank rows are simply
  // not written — a CHECK constraint refuses a row with no leg, because a reading of nothing is not
  // a reading. Re-reading the computer on the same visit corrects rather than stacks.
  if (stage === 'arrival') {
    const out = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let written = 0, cleared = 0, skipped = 0;
      for (const e of paired) {
        const legs = legsFor(e.item.basis);
        const action = classifyEntry(e.item, e);
        if (action === 'skip') { skipped += 1; continue; }   // nothing to say — see SKIPPED_BLANK_REASON
        if (action === 'clear') {
          const gone = await tx.serviceScheduleReading.deleteMany({ where: { job_card_id: card.id, item_key: e.item.key } });
          cleared += gone.count;
          continue;
        }
        const data = {
          due_month: legs.date ? monthToStoredDate(e.dueMonth) : null,
          due_mileage: legs.mileage ? (e.dueMileage ?? null) : null,
          // NULL when the garage typed a target. Not zero — a countdown of zero is a real reading
          // ("due at exactly this mileage") and must not be confused with "no countdown was read".
          countdown_miles: legs.mileage ? (e.countdownMiles ?? null) : null,
          mode: modeFor(e),
          recorded_by: user.id as string,
          recorded_at: new Date(),
        };
        await tx.serviceScheduleReading.upsert({
          where: { job_card_id_item_key: { job_card_id: card.id, item_key: e.item.key } },
          create: { group_id: groupId, vehicle_id: card.vehicle_id, job_card_id: card.id, item_key: e.item.key, ...data },
          update: data,
        });
        written += 1;
      }
      await writeAudit(tx, {
        groupId, userId: user.id as string, jobCardId,
        action: 'service_schedule.recorded',
        diff: { stage, written, cleared, skipped, odometer, skippedMeans: skipped ? SKIPPED_BLANK_REASON : undefined, entries: paired.filter((e) => !isBlank(e.item, e)).map((e) => ({ key: e.key, dueMonth: e.dueMonth ?? null, dueMileage: e.dueMileage ?? null, countdownMiles: e.countdownMiles ?? null })) },
      });
      return { written, cleared, skipped };
    });
    return res.status(200).json({ ok: true, stage, ...out });
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let written = 0, cleared = 0, skipped = 0;
    for (const e of paired) {
      const item = e.item;
      const open = await tx.vehicleDueItem.findFirst({
        where: { group_id: groupId, vehicle_id: card.vehicle_id, closed_at: null, observation_key: item.key },
        select: { id: true },
      });

      const action = classifyEntry(item, e);
      if (action === 'skip') { skipped += 1; continue; }
      if (action === 'clear') {
        // CLEARED, not ignored — a garage emptying a row IT WAS SHOWN is retracting it. A row the
        // form never held says nothing, and closing an open due item on that basis is the same
        // mistake as deleting the arrival reading, one table along.
        if (open) {
          await tx.vehicleDueItem.update({
            where: { id: open.id },
            data: { closed_at: new Date(), closed_job_card_id: card.id, closed_reason: 'No longer scheduled' },
          });
          cleared++;
        }
        continue;
      }

      const legs = legsFor(item.basis);
      const data = {
        observation_key: item.key,
        description: item.description,
        // DECLARED by the catalogue, not read off which fields arrived. Nothing here infers.
        due_basis: item.basis,
        // The 1st of the month, with the precision recorded so no renderer prints the day —
        // see lib/service-schedule::STORED_DAY_OF_MONTH for why the 1st and not the last.
        due_date: legs.date ? monthToStoredDate(e.dueMonth) : null,
        due_date_precision: 'month' as const,
        due_mileage: legs.mileage ? (e.dueMileage ?? null) : null,
        countdown_miles: legs.mileage ? (e.countdownMiles ?? null) : null,
        mode: modeFor(e),
        // The description says WHAT and the basis says WHEN — no timing in the words.
        timing_in_description: false,
      };
      if (open) await tx.vehicleDueItem.update({ where: { id: open.id }, data });
      else {
        await tx.vehicleDueItem.create({
          data: {
            group_id: groupId, vehicle_id: card.vehicle_id, found_on_job_card_id: card.id,
            // DEFAULTED HERE AND NOWHERE ELSE. A schedule row is transcribed ten months before the
            // conversation it would be an answer to — see lib/service-schedule, and the matching
            // note at lib/due-items where the opposite rule lives.
            customer_response: 'not_raised' as never,
            created_by: user.id as string,
            ...data,
          },
        });
      }
      written++;
    }
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId,
      action: 'service_schedule.recorded',
      diff: { stage, written, cleared, skipped, odometer, skippedMeans: skipped ? SKIPPED_BLANK_REASON : undefined, entries: paired.filter((e) => !isBlank(e.item, e)).map((e) => ({ key: e.key, basis: e.item.basis, dueMonth: e.dueMonth ?? null, dueMileage: e.dueMileage ?? null, countdownMiles: e.countdownMiles ?? null })) },
    });
    return { written, cleared, skipped };
  });

  return res.status(200).json({ ok: true, stage, ...result });
}
