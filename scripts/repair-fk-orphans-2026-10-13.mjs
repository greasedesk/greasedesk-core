/**
 * ONE-OFF REPAIR, 2026-10-13 — clear the orphan references that block the FK migration.
 *
 * Kept rather than deleted: the thing it repairs was itself the residue of a repair script, and
 * the only reason it was findable is that `stock.item_deleted` named itself in the audit trail.
 *
 * Dry run by default. `--apply` writes, inside one transaction per set, asserting the old value
 * before every change so a second run cannot do anything.
 */
import './_ts.mjs';
const APPLY = process.argv.includes('--apply');
const { prisma } = await import('@/lib/db');
const { writeAudit } = await import('@/lib/audit');
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CARD = 'bc69dcee-e009-4afe-8fe3-a2d2dfd48640';
const DEAD_ITEM = 'e7a59f51-6319-46d2-9854-6fedfe24400d';
const say = (s) => console.log(s);

say(APPLY ? '*** APPLYING ***\n' : '--- DRY RUN (pass --apply to write) ---\n');

// ── A · the single dangling sale pointer ────────────────────────────────────────────────────────
const card = await prisma.jobCard.findUnique({
  where: { id: CARD }, select: { id: true, status: true, group_id: true, sale_of_stock_item_id: true },
});
if (!card || card.sale_of_stock_item_id !== DEAD_ITEM) {
  say(`A · SKIP — card does not hold the expected value (already repaired?): ${JSON.stringify(card)}`);
} else if (card.status !== 'invoiced' || card.group_id !== TMBS) {
  throw new Error(`A · REFUSING — card is not the invoiced TMBS card this repair was written for: ${JSON.stringify(card)}`);
} else {
  say(`A · JobCard ${CARD}.sale_of_stock_item_id -> NULL (was ${DEAD_ITEM})`);
  if (APPLY) await prisma.$transaction(async (tx) => {
    const n = await tx.jobCard.updateMany({
      where: { id: CARD, sale_of_stock_item_id: DEAD_ITEM }, data: { sale_of_stock_item_id: null },
    });
    if (n.count !== 1) throw new Error(`A · expected 1 row, updated ${n.count}`);
    await writeAudit(tx, { groupId: TMBS, action: 'data.orphan_cleared', jobCardId: CARD, diff: {
      column: 'JobCard.sale_of_stock_item_id', was: DEAD_ITEM, now: null,
      why: 'a missed back-reference from the VS1 repair of 2026-10-11, not a product event. That repair '
         + 'deleted the stock item, cascaded StockDisposal and nulled Invoice.stock_disposal_id, but left '
         + 'this third pointer. The sale was re-recorded on card 9d251e2f with stock item '
         + 'baa46e01-f241-426f-b192-6a54ffedccb7; invoice VS1 on THIS card is void, so nothing downstream '
         + 'read it as a live sale (WIP excludes it by status and by holding an Invoice row).',
      checked: 'isSaleCard has two product readers — issueVehicleSaleInvoice (mint time; this card is at '
             + 'status invoiced and not mintable) and lib/wip (excluded twice over).',
    } });
  });
}

// ── B · answers pointing at pruned magic links ──────────────────────────────────────────────────
const bRows = await prisma.$queryRawUnsafe(`SELECT a.id FROM "DueItemCustomerAnswer" a
  WHERE a.magic_link_id IS NOT NULL AND a.group_id='${TMBS}'
    AND NOT EXISTS (SELECT 1 FROM "CustomerMagicLink" m WHERE m.id=a.magic_link_id)`);
say(`B · DueItemCustomerAnswer.magic_link_id -> NULL on ${bRows.length} row(s) (TMBS)`);
if (APPLY && bRows.length) await prisma.$transaction(async (tx) => {
  const ids = bRows.map(r => r.id);
  const n = await tx.dueItemCustomerAnswer.updateMany({
    where: { id: { in: ids }, group_id: TMBS }, data: { magic_link_id: null },
  });
  if (n.count !== ids.length) throw new Error(`B · expected ${ids.length}, updated ${n.count}`);
  await writeAudit(tx, { groupId: TMBS, action: 'data.orphan_cleared',
    entity: 'due_item_customer_answer', entityId: ids[0], diff: {
      column: 'DueItemCustomerAnswer.magic_link_id', rows: ids, now: null,
      why: 'the magic link was pruned after expiry; the ANSWER is the record and survives it. Cleared so '
         + 'the column can take an FK with ON DELETE SET NULL, which makes this automatic in future.',
    } });
});

// ── C · ZZ gate residue on a FROZEN rate link ───────────────────────────────────────────────────
const cRows = await prisma.$queryRawUnsafe(`SELECT c.id, c.group_id FROM "CommissionEntry" c
  WHERE NOT EXISTS (SELECT 1 FROM "CommissionRate" r WHERE r.id=c.rate_id)`);
const nonZz = cRows.filter(r => r.group_id !== ZZ);
if (nonZz.length) throw new Error(`C · REFUSING — ${nonZz.length} orphan commission entries are NOT ZZ: ${JSON.stringify(nonZz)}`);
say(`C · CommissionEntry DELETE ${cRows.length} row(s) — all ZZ gate residue (rate_id is NOT NULL and FROZEN, so it cannot be nulled)`);
if (APPLY && cRows.length) await prisma.$transaction(async (tx) => {
  const ids = cRows.map(r => r.id);
  await writeAudit(tx, { groupId: ZZ, action: 'data.orphan_cleared',
    entity: 'commission_entry', entityId: ids[0], diff: {
      column: 'CommissionEntry.rate_id', deleted_rows: ids,
      why: 'gate residue on the ZZ tenant naming a CommissionRate that no longer exists. rate_id is NOT '
         + 'NULL and is the FROZEN link to the rate applied, so SET NULL would destroy the freeze — the '
         + 'rows go instead. No real tenant row was touched.',
    } });
  const n = await tx.commissionEntry.deleteMany({ where: { id: { in: ids }, group_id: ZZ } });
  if (n.count !== ids.length) throw new Error(`C · expected ${ids.length}, deleted ${n.count}`);
});

// ── D · telemetry: NOT cleared, deliberately ────────────────────────────────────────────────────
const d = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "UploadTelemetry" t
  WHERE t.photo_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "JobCardPhoto" p WHERE p.id=t.photo_id)`);
say(`D · UploadTelemetry.photo_id — ${d[0].n} orphan(s) LEFT AS THEY ARE.`);
say('     photo_id is NOT NULL, so "clearing" them means DELETING real TMBS telemetry rows. The decision');
say('     was NO CONSTRAINT on this column, so nothing requires it. Deleting them would be pure loss.');
await prisma.$disconnect();
