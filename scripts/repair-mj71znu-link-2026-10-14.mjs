/** ONE-OFF, 2026-10-14: revoke the live customer link on a card the garage declined on 13 Oct.
 *  The product path does not yet do this (jobcard-status revokes on cancelled/no_show only), so
 *  the link was accepting £2,074.06 of declined work until tomorrow lunchtime. Owner's instruction. */
import './_ts.mjs';
const APPLY = process.argv.includes('--apply');
const { prisma } = await import('@/lib/db');
const { revokeMagicLinksForCard } = await import('@/lib/magic-link');
const { writeAudit } = await import('@/lib/audit');
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const CARD = '54cf1308-a196-40b0-9fb4-35e403bcb41d';

const card = await prisma.jobCard.findUnique({ where: { id: CARD }, select: { status: true, group_id: true } });
if (!card || card.status !== 'declined' || card.group_id !== TMBS) {
  throw new Error(`REFUSING — not the declined TMBS card this was written for: ${JSON.stringify(card)}`);
}
const live = await prisma.customerMagicLink.findMany({
  where: { job_card_id: CARD, revoked_at: null }, select: { id: true, purpose: true, expires_at: true },
});
console.log(`${APPLY ? '*** APPLYING ***' : '--- DRY RUN ---'}  live links: ${live.length}`);
for (const l of live) console.log(`   ${l.purpose} expiring ${l.expires_at.toISOString()}`);
if (APPLY && live.length) {
  await prisma.$transaction(async (tx) => {
    const n = await revokeMagicLinksForCard(CARD, 'declined', tx);
    if (n !== live.length) throw new Error(`expected ${live.length}, revoked ${n}`);
    await writeAudit(tx, { groupId: TMBS, action: 'quote.link_revoked', jobCardId: CARD, diff: {
      reason: 'declined', links: live.length,
      why: 'the garage marked this card declined on 2026-10-13 and the product path did not revoke the '
         + "customer's link — jobcard-status revokes on cancelled and no_show only, and 'declined' is a "
         + 'RevokeReason that was declared and never passed. The link was live until 2026-10-15 11:41 and '
         + 'would have accepted £2,074.06 of work the garage had said no to. Done by hand ahead of the fix.',
    } });
  });
  console.log('   revoked, with an audit row');
}
await prisma.$disconnect();
