import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const to = process.argv[2];
await p.groupBilling.update({ where:{ id:'377efc8a-063c-4316-9f7e-c3ccf4e665e9' }, data:{ subscription_status: to } });
console.log('ZZ subscription_status →', to);
await p.$disconnect();
