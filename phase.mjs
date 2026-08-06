import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const ID='377efc8a-063c-4316-9f7e-c3ccf4e665e9';
const mode = process.argv[2];
const day = 86400000;
const data = mode === 'ok'         ? { subscription_status:'active',   grace_started_at:null, grace_reason:null }
           : mode === 'grace'      ? { subscription_status:'past_due',  grace_started_at:new Date(Date.now()-3*day), grace_reason:'payment_failed' }
           : mode === 'restricted' ? { subscription_status:'past_due',  grace_started_at:new Date(Date.now()-9*day), grace_reason:'payment_failed' }
           : mode === 'trialgrace' ? { subscription_status:'past_due',  grace_started_at:new Date(Date.now()-2*day), grace_reason:'trial_ended' }
           :                         { subscription_status:'canceled',  grace_started_at:new Date(Date.now()-9*day), grace_reason:'payment_failed' };
await p.groupBilling.update({ where:{ id:ID }, data });
console.log(`ZZ → ${mode}: ${JSON.stringify(data)}`);
await p.$disconnect();
