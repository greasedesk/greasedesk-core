import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const ref = 'GB-PURGEN' + String(Date.now()).slice(-4);
const g = await p.group.create({ data: { group_name:'ZZ Purge Probe — no subscription', ref,
  billing_email:`purge-nosub-${Date.now()}@zzgategarage.test`, tax_country_code:'GB', country_code:'GB', is_internal:true }, select:{id:true} });
// A billing row with NO subscription id — nothing to cancel, nothing to confirm.
await p.groupBilling.create({ data:{ group_id:g.id, plan_name:'probe', status:'ok', retention_months:12, included_sites:1 } });
console.log(g.id);
await p.$disconnect();
