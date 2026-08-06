import { purgeTenant } from '@/lib/tenant-purge';
import { prisma } from '@/lib/db';
const groupId = process.argv[2];
const OPERATOR = '3255a238-a9f3-45a0-9ff9-2a69111c41fa'; // Iain, the seeded platform operator
const before = await prisma.group.count({ where: { id: groupId } });
console.log(`Group row before: ${before}`);
try {
  const r = await purgeTenant(OPERATOR, groupId);
  console.log('purgeTenant RETURNED — stripe:', JSON.stringify(r.stripe));
} catch (e: any) {
  console.log('purgeTenant THREW:', e?.name, 'code=' + e?.code, JSON.stringify(e?.meta ?? {}));
}
const after = await prisma.group.count({ where: { id: groupId } });
console.log(`Group row after : ${after}   → ${after === 0 ? 'DELETED' : 'SURVIVED'}`);
await prisma.$disconnect();
