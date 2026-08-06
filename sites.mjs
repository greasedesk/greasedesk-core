import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const G='c75ac44e-250a-4c90-98ba-a8326e98dad5';
const n = Number(process.argv[2] ?? 0);
if (n > 0) for (let i=0;i<n;i++) await p.site.create({ data:{ group_id:G, site_name:`ZZ Idem Probe ${Date.now()}-${i}` } });
else await p.site.deleteMany({ where:{ group_id:G, site_name:{ startsWith:'ZZ Idem Probe' } } });
console.log('ZZ sites now:', await p.site.count({ where:{ group_id:G } }));
await p.$disconnect();
