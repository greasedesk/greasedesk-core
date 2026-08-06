import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const ref = 'GB-PURGE' + String(Date.now()).slice(-5);
const g = await p.group.create({ data: {
  group_name: 'ZZ Purge Probe (throwaway)', ref, billing_email: `purge-probe-${Date.now()}@zzgategarage.test`,
  tax_country_code: 'GB', country_code: 'GB', is_internal: true,
}, select: { id:true, ref:true } });
await p.groupBilling.create({ data: { group_id: g.id, plan_name:'probe', status:'ok', retention_months:12, included_sites:1,
  // A subscription id the product BELIEVES it has. Cancelling it is what must be confirmed.
  stripe_subscription_id: 'sub_PURGEPROBE' + String(Date.now()).slice(-6), subscription_status: 'active' } });
console.log(JSON.stringify({ id: g.id, ref: g.ref }));
await p.$disconnect();
