// Car-first re-root, STAGE C destructive test — THROWAWAY TENANT ONLY, never live TMBS.
// Proves the new delete-semantics: deleting a Customer severs the person but leaves the car + work
// history intact and reachable via vehicle_id, and leaves any issued invoice's frozen snapshot
// untouched. MUST run AFTER the Stage C migration has applied (needs the SET NULL FKs).
//
//   node --env-file=.env prisma/scripts/destructive_test_stage_c.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const g = await p.group.create({ data: { group_name: 'ZZ Stage-C destroy', billing_email: `zz-c-${Date.now()}@throwaway.test` }, select: { id: true } });
  const s = await p.site.create({ data: { group_id: g.id, site_name: 'ZZ C site' }, select: { id: true } });
  let failed = false;
  const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed = true; };

  try {
    // Owner + car (with the weld SET, mirroring the 8 live vehicles) + identity + current edge.
    const c = await p.customer.create({ data: { group_id: g.id, site_id: s.id, name: 'Doomed Owner', phone: '0100', email: 'd@x.test' }, select: { id: true, name: true } });
    const idn = await p.vehicleIdentity.create({ data: { group_id: g.id, vin_normalized: 'SCDESTROY0001', registration: 'ZZC1 REG' }, select: { id: true } });
    const v = await p.vehicle.create({ data: { group_id: g.id, customer_id: c.id, identity_id: idn.id, vin_normalized: 'SCDESTROY0001', registration: 'ZZC1 REG' }, select: { id: true } });
    await p.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: c.id, is_current: true } });
    const jc1 = await p.jobCard.create({ data: { group_id: g.id, site_id: s.id, customer_id: c.id, vehicle_id: v.id }, select: { id: true } });
    const jc2 = await p.jobCard.create({ data: { group_id: g.id, site_id: s.id, customer_id: c.id, vehicle_id: v.id }, select: { id: true } });
    const bk = await p.booking.create({ data: { group_id: g.id, site_id: s.id, customer_id: c.id, vehicle_id: v.id, booking_date: new Date() }, select: { id: true } });
    // Issued invoice with a FROZEN snapshot of the (soon-deleted) person. Invoice has NO customer FK.
    const inv = await p.invoice.create({ data: {
      group_id: g.id, site_id: s.id, job_card_id: jc1.id, sequence_value: 1, invoice_number: 'ZZC-0001',
      company_name_snapshot: 'ZZ Garage', customer_name_snapshot: c.name, vehicle_reg_snapshot: 'ZZC1 REG',
      vat_registered_at_issue: true,
    }, select: { id: true } });

    // --- DELETE THE PERSON ---
    let deleteOk = true, deleteErr = '';
    try { await p.customer.delete({ where: { id: c.id } }); } catch (e) { deleteOk = false; deleteErr = e.message.split('\n')[0]; }
    check(`customer delete SUCCEEDS (no NoAction block)${deleteOk ? '' : ' — ' + deleteErr}`, deleteOk);

    const [custGone, vh, cards, viaVehicle, booking, edges, identity, invoice] = await Promise.all([
      p.customer.count({ where: { id: c.id } }),
      p.vehicle.findUnique({ where: { id: v.id }, select: { id: true, customer_id: true } }),
      p.jobCard.findMany({ where: { id: { in: [jc1.id, jc2.id] } }, select: { id: true, customer_id: true, vehicle_id: true } }),
      p.jobCard.count({ where: { vehicle_id: v.id } }),
      p.booking.findUnique({ where: { id: bk.id }, select: { customer_id: true } }),
      p.vehicleOwnership.count({ where: { vehicle_id: v.id } }),
      p.vehicleIdentity.count({ where: { id: idn.id } }),
      p.invoice.findUnique({ where: { id: inv.id }, select: { customer_name_snapshot: true, job_card_id: true } }),
    ]);

    check('customer row gone', custGone === 0);
    check('vehicle SURVIVES', !!vh);
    check('vehicle.customer_id SetNull -> null', vh && vh.customer_id === null);
    check('both job cards SURVIVE', cards.length === 2);
    check('job cards customer_id SetNull -> null', cards.every((r) => r.customer_id === null));
    check('work history reachable via vehicle_id (2 cards)', viaVehicle === 2);
    check('booking SURVIVES with customer_id null', booking && booking.customer_id === null);
    check('ownership edge CASCADE-removed (0)', edges === 0);
    check('vehicle identity survives', identity === 1);
    check('issued invoice UNTOUCHED (snapshot intact, still linked)', invoice && invoice.customer_name_snapshot === 'Doomed Owner' && invoice.job_card_id === jc1.id);

    console.log(failed ? '\nSTAGE C DESTRUCTIVE TEST: FAIL ❌' : '\nSTAGE C DESTRUCTIVE TEST: PASS ✅');

    // Teardown (dependency order: invoice -> booking -> jobcards -> group cascades vehicle/identity/site)
    await p.invoice.delete({ where: { id: inv.id } });
    await p.booking.delete({ where: { id: bk.id } });
    await p.jobCard.deleteMany({ where: { group_id: g.id } });
    await p.group.delete({ where: { id: g.id } });
    const resid = (await p.vehicle.count({ where: { group_id: g.id } })) + (await p.vehicleIdentity.count({ where: { group_id: g.id } })) + (await p.group.count({ where: { id: g.id } }));
    console.log(`teardown residuals (vehicles+identities+group): ${resid} (expect 0)`);
    if (failed) process.exit(1);
  } catch (e) {
    console.error('STAGE C TEST ERROR:', e.message);
    // best-effort cleanup
    await p.invoice.deleteMany({ where: { group_id: g.id } }).catch(() => {});
    await p.booking.deleteMany({ where: { group_id: g.id } }).catch(() => {});
    await p.jobCard.deleteMany({ where: { group_id: g.id } }).catch(() => {});
    await p.group.delete({ where: { id: g.id } }).catch(() => {});
    process.exit(1);
  } finally { await p.$disconnect(); }
})();
