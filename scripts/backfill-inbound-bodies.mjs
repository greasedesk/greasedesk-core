/**
 * scripts/backfill-inbound-bodies.mjs
 * Retrieve bodies for inbound rows recorded without one (the webhook never fails on a body-fetch
 * error — the arrival is the thing that must not be lost, and the text follows).
 *
 * URGENT BY DESIGN: Resend discards received mail after 30 DAYS. After that their API cannot answer
 * and the body is gone for good, so this reports how close each gap is to that cliff.
 *   --dry (default) | --commit
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const RETENTION_DAYS = 30;

const rows = await prisma.notificationLog.findMany({
  where: { direction: 'in', body: null, provider_message_id: { not: null } },
  select: { id: true, provider_message_id: true, received_at: true, created_at: true },
  orderBy: { created_at: 'asc' },
});
console.log(`inbound rows missing a body: ${rows.length}`);
let done = 0, gone = 0, failed = 0;
for (const r of rows) {
  const at = r.received_at ?? r.created_at;
  const ageDays = (Date.now() - at.getTime()) / 86400000;
  if (ageDays > RETENTION_DAYS) { gone++; console.log(`  ${r.id} — ${ageDays.toFixed(1)}d old: PAST RESEND'S 30-DAY RETENTION, body unrecoverable`); continue; }
  if (!COMMIT) { console.log(`  ${r.id} — ${ageDays.toFixed(1)}d old, ${(RETENTION_DAYS - ageDays).toFixed(1)}d left to retrieve`); continue; }
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(r.provider_message_id)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    if (!res.ok) { failed++; console.log(`  ${r.id} — provider said ${res.status}`); continue; }
    const j = await res.json();
    await prisma.notificationLog.update({ where: { id: r.id }, data: { body: j.text ?? null, body_html: j.html ?? null } });
    done++;
  } catch (e) { failed++; console.log(`  ${r.id} — ${e.message}`); }
}
console.log(COMMIT ? `\nbackfilled ${done}, failed ${failed}, unrecoverable ${gone}` : `\nDRY RUN — ${rows.length} candidates, ${gone} already past retention`);
await prisma.$disconnect();
