/**
 * File: scripts/_live-credentials.mjs
 * LIVE CREDENTIALS ON THE GATE TENANT, as JSON on stdout. A child process for the same reason
 * _reap-loopback-limits is one: scripts/gates.mjs orchestrates and does not hold a Prisma client.
 *
 * Printing id + created_at rather than a count is what lets the runner ATTRIBUTE a leftover
 * credential to the gate whose run window contains it. Gates run strictly sequentially, so the
 * windows do not overlap and the attribution is exact rather than a guess.
 */
import './_gate-preflight.mjs';
const { gatePrisma, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
try {
  const prisma = await gatePrisma();
  const rows = await prisma.customerMagicLink.findMany({
    where: { group_id: ZZ_GROUP, revoked_at: null, consumed_at: null, expires_at: { gt: new Date() } },
    select: { id: true, purpose: true, created_at: true, recipient: true },
    orderBy: { created_at: 'asc' },
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    live: rows.map((r) => ({ id: r.id, purpose: r.purpose, at: r.created_at.getTime(), recipient: String(r.recipient).slice(0, 24) })),
  }));
  await prisma.$disconnect();
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 120) }));
}
