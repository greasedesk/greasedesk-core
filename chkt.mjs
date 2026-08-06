import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const id = process.argv[2];
const g = await p.group.findUnique({ where:{id}, select:{ group_name:true, ref:true, billing:{ select:{ stripe_subscription_id:true, subscription_status:true } } } });
console.log(g ? JSON.stringify(g) : 'GROUP GONE');
await p.$disconnect();
