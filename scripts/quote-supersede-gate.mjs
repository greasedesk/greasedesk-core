/**
 * File: scripts/quote-supersede-gate.mjs
 * @gate-requires: db, server
 *
 * WHETHER A CUSTOMER'S LIVE QUOTE LINK DIES.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * `supersedeOnMaterialEdit` decides, every time a garage saves an estimate, whether the quote
 * sitting in a customer's inbox is revoked. It had NO CLAUSE ANYWHERE. Two gates drove the endpoint
 * that calls it, so a name search said "covered" and the behaviour said "exercised" — and neither
 * said PROVED. The rule itself (material supersedes, immaterial does not) was asserted nowhere.
 *
 * It stayed invisible partly because lib/quote-version.ts held a raw NUL byte, so grep printed
 * nothing for the file and a coverage survey over it found nothing to be missing.
 *
 * THE LINK IS THE SUBJECT, not the status. So the clauses below fetch /c/<token> as the customer
 * would and ask whether the quote still opens — a status column saying `superseded` proves nothing
 * about whether somebody can still accept yesterday's price.
 *
 * FIXTURES on ZZ, prefix ZZSUP, swept before and after and registered with onTeardown.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const { hasKey } = await import('/Users/hugh/Developer/greasedesk-core/lib/anchored-match.ts');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const SUP = 'ZZSUP';

const prisma = await gatePrisma();
let made = null;

const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 110)}`); } };
/** ONE SWEEP, TWO CALLERS — registered so the runner's cap can run it over SIGTERM. Idempotent. */
const sweepFixtures = async () => {
  const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: SUP } }, select: { id: true } });
  const ids = vs.map((v) => v.id);
  const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
  await step('links', () => prisma.customerMagicLink.deleteMany({ where: { job_card_id: { in: cards } } }));
  const vers = (await prisma.quoteVersion.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((v) => v.id);
  await step('version lines', () => prisma.quoteVersionLine.deleteMany({ where: { quote_version_id: { in: vers } } }));
  await step('options', () => prisma.quoteOption.deleteMany({ where: { quote_version_id: { in: vers } } }));
  await step('versions', () => prisma.quoteVersion.deleteMany({ where: { id: { in: vers } } }));
  await step('items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } }));
  await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: cards } } }));
  await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: ids } } }));
  await step('customers', () => prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: SUP } } }));
};
onTeardown(sweepFixtures);

try {
  const origin = gateOrigin();
  await serverReady(origin);
  await sweepFixtures();
  const V = await import(`${R}/lib/quote-version.ts`);
  const { createMagicLink } = await import(`${R}/lib/magic-link.ts`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  let n = 0;
  /** A card with a quote OUT with the customer, link and all — the state every clause is about. */
  const outWithCustomer = async (opts = {}) => {
    n += 1;
    const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${SUP} C${n}` }, select: { id: true } });
    const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${SUP}${n}`, registration_normalized: `${SUP}${n}` }, select: { id: true } });
    const card = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: opts.status ?? 'quoted' }, select: { id: true } });
    const v = await prisma.quoteVersion.create({
      data: { group_id: ZZ_GROUP, job_card_id: card.id, version: 1, status: opts.status === 'accepted' ? 'accepted' : 'sent',
        net_pennies: 10000, vat_pennies: 2000, gross_pennies: 12000,
        vat_registered: opts.vatRegistered ?? true, tax_label: 'VAT', created_by_user: user.id,
        lines: { create: [
          { position: 1, item_type: 'fixed', description: 'Brake pads', qty: 1, unit_price: 50, vat_rate: 20, line_vat: 10, line_total: 50, labour_outsourced: false },
          { position: 2, item_type: 'fixed', description: 'Discs', qty: 1, unit_price: 50, vat_rate: 20, line_vat: 10, line_total: 50, labour_outsourced: false },
        ] } },
      select: { id: true },
    });
    /**
     * THE SAVED ESTIMATE, not just the frozen version. `reviseAcceptedQuote` compares `incoming`
     * for materiality but freezes from the card's own JobCardItem rows — so a fixture with a
     * version and no estimate throws NO_LINES. In the real flow /api/jobcard-quote saves the items
     * first and then calls revise; the fixture has to walk the same order.
     */
    await prisma.jobCardItem.createMany({ data: [
      { job_card_id: card.id, description: 'Brake pads', qty: 1, unit_price: 50, vat_rate: 20, item_type: 'fixed' },
      { job_card_id: card.id, description: 'Discs', qty: 1, unit_price: 50, vat_rate: 20, item_type: 'fixed' },
    ] });
    const link = await createMagicLink({ groupId: ZZ_GROUP, jobCardId: card.id, purpose: 'quote_view', recipient: 'zzsup@example.invalid', baseUrl: origin });
    await prisma.quoteVersion.update({ where: { id: v.id }, data: { magic_link_id: link.id } });
    return { cardId: card.id, versionId: v.id, link };
  };
  /** Does the customer's link still open the quote? The only question that matters to them. */
  const linkOpens = async (link) => {
    const html = await (await fetch(link.url)).text();
    // hasKey, not a hand-written /"reason":/ — a property matcher written per gate is the substring
    // trap this suite has met ten times (lib/anchored-match).
    const denied = hasKey(html, 'reason', /"(revoked|no_quote|not_found|not_available)"/);
    return !denied && html.includes('Accept quote');
  };
  const sameLines = [
    { description: 'Brake pads', qty: 1, unit_price: 50, vat_rate: 20 },
    { description: 'Discs', qty: 1, unit_price: 50, vat_rate: 20 },
  ];

  console.log('— NOTHING OUT WITH THE CUSTOMER —');
  const quiet = await outWithCustomer();
  await prisma.quoteVersion.update({ where: { id: quiet.versionId }, data: { status: 'declined' } });
  const r0 = await V.supersedeOnMaterialEdit(quiet.cardId, [{ description: 'Anything', qty: 9, unit_price: 9, vat_rate: 20 }]);
  check('with no live version, nothing is superseded and nothing is claimed immaterial',
    r0.superseded === 0 && r0.immaterial === false && r0.liveVersion === null, JSON.stringify(r0));

  console.log('\n— AN IMMATERIAL EDIT LEAVES THE CUSTOMER THEIR LINK —');
  const keep = await outWithCustomer();
  check('  …the link opens before the edit', await linkOpens(keep.link));
  /** Reordered and re-spaced: the same offer, typed differently. */
  const r1 = await V.supersedeOnMaterialEdit(keep.cardId, [
    { description: '  Discs ', qty: 1, unit_price: 50, vat_rate: 20 },
    { description: 'Brake pads', qty: 1, unit_price: 50, vat_rate: 20 },
  ]);
  check('reordering the lines and re-spacing a description is IMMATERIAL',
    r1.immaterial === true && r1.superseded === 0 && r1.liveVersion === 1, JSON.stringify(r1));
  const kept = await prisma.quoteVersion.findUnique({ where: { id: keep.versionId }, select: { status: true } });
  check('  …the version is still the live offer', kept?.status === 'sent', String(kept?.status));
  check('  …AND THE CUSTOMER CAN STILL OPEN IT, which is the part that matters', await linkOpens(keep.link));

  console.log('\n— A MATERIAL EDIT TAKES THE LINK AWAY —');
  const kill = await outWithCustomer();
  check('  …the link opens before the edit', await linkOpens(kill.link));
  const r2 = await V.supersedeOnMaterialEdit(kill.cardId, [
    { description: 'Brake pads', qty: 1, unit_price: 90, vat_rate: 20 },
    { description: 'Discs', qty: 1, unit_price: 50, vat_rate: 20 },
  ]);
  check('a price change supersedes the live offer', r2.immaterial === false && r2.superseded === 1 && r2.liveVersion === 1, JSON.stringify(r2));
  const killed = await prisma.quoteVersion.findUnique({ where: { id: kill.versionId }, select: { status: true } });
  check('  …the version reads superseded', killed?.status === 'superseded', String(killed?.status));
  /** THE CLAUSE THIS GATE EXISTS FOR: a status column cannot tell you whether somebody can still
   *  accept yesterday's price. The link can. */
  check('  …AND THE LINK IS DEAD, so nobody can accept the old price', !(await linkOpens(kill.link)));

  console.log('\n— WHAT COUNTS AS MATERIAL —');
  const cases = [
    ['a quantity change', [{ description: 'Brake pads', qty: 2, unit_price: 50, vat_rate: 20 }, sameLines[1]], true],
    ['a new line', [...sameLines, { description: 'Fluid', qty: 1, unit_price: 10, vat_rate: 20 }], true],
    ['a removed line', [sameLines[0]], true],
    ['a reworded description', [{ description: 'Brake pads (front)', qty: 1, unit_price: 50, vat_rate: 20 }, sameLines[1]], true],
  ];
  const wrong = [];
  for (const [label, lines, expectMaterial] of cases) {
    const f = await outWithCustomer();
    const r = await V.supersedeOnMaterialEdit(f.cardId, lines);
    const material = !r.immaterial && r.superseded > 0;
    if (material !== expectMaterial) wrong.push(`${label} read as ${material ? 'material' : 'immaterial'}`);
  }
  check(`every shape of change is material (${cases.length} checked)`, wrong.length === 0, wrong.join(' | ') || cases.map(([l]) => l).join(', '));

  /** THE ONE WITH A REASON ATTACHED: an unregistered quote prints no VAT column, so a rate change
   *  there is invisible to the customer and must not take their link away. */
  const unreg = await outWithCustomer({ vatRegistered: false });
  const r3 = await V.supersedeOnMaterialEdit(unreg.cardId, [
    { description: 'Brake pads', qty: 1, unit_price: 50, vat_rate: 5 },
    { description: 'Discs', qty: 1, unit_price: 50, vat_rate: 5 },
  ]);
  check('a VAT-rate-only change on an UNREGISTERED quote is immaterial', r3.immaterial === true, JSON.stringify(r3));
  check('  …so that customer keeps their link too', await linkOpens(unreg.link));
  const reg = await outWithCustomer({ vatRegistered: true });
  const r4 = await V.supersedeOnMaterialEdit(reg.cardId, [
    { description: 'Brake pads', qty: 1, unit_price: 50, vat_rate: 5 },
    { description: 'Discs', qty: 1, unit_price: 50, vat_rate: 5 },
  ]);
  check('  …and the SAME change IS material when registered, because the page shows VAT',
    r4.immaterial === false && r4.superseded === 1, JSON.stringify(r4));

  console.log('\n— THE EXTRA HOUR, AGREED BY PHONE —');
  const acc = await outWithCustomer({ status: 'accepted' });
  const revArgs = { groupId: ZZ_GROUP, jobCardId: acc.cardId, vatRegistered: true, taxLabel: 'VAT', createdByUserId: user.id };
  const rev0 = await V.reviseAcceptedQuote({ ...revArgs, incoming: sameLines });
  check('an estimate matching the accepted quote mints nothing', rev0 === null, JSON.stringify(rev0));
  // The mechanic writes the extra hour down — which is the saved estimate changing — and THEN the
  // save path calls revise. Same order as /api/jobcard-quote.
  await prisma.jobCardItem.create({ data: { job_card_id: acc.cardId, description: 'Extra hour', qty: 1, unit_price: 60, vat_rate: 20, item_type: 'labour' } });
  const rev1 = await V.reviseAcceptedQuote({
    ...revArgs,
    incoming: [...sameLines, { description: 'Extra hour', qty: 1, unit_price: 60, vat_rate: 20 }],
  });
  check('adding the extra hour mints a revision without anyone pressing a button', !!rev1, JSON.stringify(rev1));
  const minted = await prisma.quoteVersion.findFirst({
    where: { job_card_id: acc.cardId }, orderBy: { version: 'desc' },
    select: { version: true, sent_to: true, magic_link_id: true, status: true },
  });
  check('  …minted UNSENT, because nothing was sent', minted?.version === 2 && minted.sent_to === null,
    `v${minted?.version} sent_to=${minted?.sent_to}`);
  /** No credential nobody asked for: there is no customer link to hand out for a phone call. */
  check('  …and with NO magic link, because there is nothing for a customer to open',
    minted?.magic_link_id === null, String(minted?.magic_link_id));
  /**
   * TWO RULES, ONE OUTCOME — so they need two fixtures. The first version of this clause used a
   * card with a SENT version and claimed to prove "no accepted version revises nothing"; it
   * actually proved the nothing-already-open guard, and would have passed with the accepted check
   * deleted.
   */
  const declined = await outWithCustomer();
  await prisma.quoteVersion.update({ where: { id: declined.versionId }, data: { status: 'declined' } });
  const rev2 = await V.reviseAcceptedQuote({ groupId: ZZ_GROUP, jobCardId: declined.cardId, vatRegistered: true, taxLabel: 'VAT', incoming: [...sameLines, { description: 'Extra', qty: 1, unit_price: 9, vat_rate: 20 }] });
  check('a card with NO accepted version revises nothing, even with a changed estimate', rev2 === null, JSON.stringify(rev2));
  /**
   * AN ACCEPTED VERSION *AND* ONE STILL OUT. Without the accepted one, dropping the open-guard
   * still returns null via the accepted check — which is how the first version of this clause went
   * 0 RED under that mutation. Here the accepted check cannot be the reason, so only the guard can.
   */
  const bothOut = await outWithCustomer({ status: 'accepted' });
  await prisma.quoteVersion.create({
    data: { group_id: ZZ_GROUP, job_card_id: bothOut.cardId, version: 2, status: 'sent',
      net_pennies: 10000, vat_pennies: 2000, gross_pennies: 12000, vat_registered: true, tax_label: 'VAT' },
  });
  await prisma.jobCardItem.create({ data: { job_card_id: bothOut.cardId, description: 'Extra', qty: 1, unit_price: 9, vat_rate: 20, item_type: 'fixed' } });
  const rev3 = await V.reviseAcceptedQuote({ groupId: ZZ_GROUP, jobCardId: bothOut.cardId, vatRegistered: true, taxLabel: 'VAT', incoming: [...sameLines, { description: 'Extra', qty: 1, unit_price: 9, vat_rate: 20 }] });
  const after3 = await prisma.quoteVersion.count({ where: { job_card_id: bothOut.cardId } });
  check('  …and an accepted card whose quote is ALSO still out revises nothing, so the two paths cannot race to mint',
    rev3 === null && after3 === 2, `${JSON.stringify(rev3)}, ${after3} version(s)`);

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await sweepFixtures();
  try {
    const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: SUP } } });
    check('teardown removed every fixture row', left === 0, `${left} left`);
  } catch (e) { check('teardown verified', false, describeError(e).slice(0, 110)); }
  await prisma.$disconnect().catch(() => {});
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
