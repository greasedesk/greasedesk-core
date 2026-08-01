/**
 * File: lib/inbound-body-sweep.ts
 * Retry the body fetch for inbound rows that arrived without one.
 *
 * WHY THIS IS A SWEEP AND NOT A ONE-OFF SCRIPT: a body-fetch failure at webhook time is expected —
 * the webhook must never fail on it — so something has to come back and try again, automatically.
 * Waiting for a human to notice a missing body is not a recovery mechanism.
 *
 * IT IS ALSO ON A CLOCK. Resend discards received mail after 30 DAYS; past that their API cannot
 * answer and the text is gone for good, so a row that ages out is reported as PERMANENTLY lost
 * rather than retried forever in silence.
 */
import type { PrismaClient } from '@prisma/client';
import { fetchInboundBody } from '@/lib/inbound';

export const RESEND_RETENTION_DAYS = 30;

export type BodySweepResult = {
  candidates: number; recovered: number; stillFailing: number; pastRetention: number;
  /** The provider's own words, so a failure diagnoses itself instead of needing a guess. */
  reasons: Record<string, number>;
  examples: Array<{ id: string; ageDays: number; error: string | null }>;
};

export async function runInboundBodySweep(db: PrismaClient, limit = 50): Promise<BodySweepResult> {
  const rows = await db.notificationLog.findMany({
    where: { direction: 'in', body: null, body_html: null, provider_message_id: { not: null } },
    select: { id: true, provider_message_id: true, received_at: true, created_at: true },
    orderBy: { created_at: 'asc' },
    take: limit,
  });

  const out: BodySweepResult = { candidates: rows.length, recovered: 0, stillFailing: 0, pastRetention: 0, reasons: {}, examples: [] };
  for (const r of rows) {
    const at = r.received_at ?? r.created_at;
    const ageDays = (Date.now() - at.getTime()) / 86400000;
    if (ageDays > RESEND_RETENTION_DAYS) {
      out.pastRetention++;
      const why = `past Resend's ${RESEND_RETENTION_DAYS}-day retention — body unrecoverable`;
      out.reasons[why] = (out.reasons[why] ?? 0) + 1;
      await db.notificationLog.update({ where: { id: r.id }, data: { body_error: why } }).catch(() => {});
      out.examples.push({ id: r.id, ageDays: Number(ageDays.toFixed(2)), error: why });
      continue;
    }
    const got = await fetchInboundBody(r.provider_message_id as string);
    if (got.ok) {
      out.recovered++;
      await db.notificationLog.update({ where: { id: r.id }, data: { body: got.text, body_html: got.html, body_error: null } });
      out.examples.push({ id: r.id, ageDays: Number(ageDays.toFixed(2)), error: null });
    } else {
      out.stillFailing++;
      const why = got.error ?? 'unknown';
      out.reasons[why] = (out.reasons[why] ?? 0) + 1;
      // PERSIST THE REASON. The whole point: a missing body must explain itself on the row.
      await db.notificationLog.update({ where: { id: r.id }, data: { body_error: why } }).catch(() => {});
      out.examples.push({ id: r.id, ageDays: Number(ageDays.toFixed(2)), error: why });
    }
  }
  return out;
}
