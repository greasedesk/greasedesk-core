/**
 * File: scripts/sale-invoice-gate.mjs
 * @gate-requires: db
 *
 * THE SALE INVOICE — step 1: the series, and the VAT position.
 *
 * A car sold out of stock produces a VAT document with a SECOND ORIGIN: it hangs off a
 * StockDisposal, not a job card. This gate covers the two things that must be right before any such
 * document can be minted — which counter and prefix it uses, and which VAT treatment it carries.
 *
 * ── WHAT THE SERIES IS NOT ──────────────────────────────────────────────────────────────────────
 * The series is not a statement about VAT. A margin-scheme car and a qualifying one are both
 * `vehicle_sale` and are taxed on entirely different bases, so nothing may infer the treatment from
 * the series. Invoice.vat_position carries it.
 *
 * ── THE DEFECT FOUND ON THE WAY IN ──────────────────────────────────────────────────────────────
 * `vatPositionFor` took the disposal KIND alone and returned 'margin' for every sale. That is right
 * for a margin car and wrong for a qualifying one by a sixth of the whole purchase price: a
 * qualifying car had its input tax reclaimed at purchase, so output tax is due on the FULL selling
 * price and is not floored at zero. LATENT, never computed: when this was fixed every StockItem in
 * the database was `margin` and no disposal existed anywhere. `vatStatus` is now a required argument
 * with no default, so the omission cannot come back quietly.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => (p == null ? 'null' : `£${(p / 100).toFixed(2)}`);

const S = await import('/Users/hugh/Developer/greasedesk-core/lib/stock.ts');
const NUM = await import('/Users/hugh/Developer/greasedesk-core/lib/invoice-number.ts');

let prisma;
try {
  prisma = await gatePrisma();
  /**
   * THE DRIFT CHECK RUNS FIRST, AND DELIBERATELY. It used to sit third, behind the prefix loop — and
   * when the union was mutated to prove it, `prefixForSeries` threw on the unknown series and ended
   * the gate at clause 1 of 30, so the clause that names the defect never ran. A gate that throws
   * reports the prefix it reached, not the clauses it has. Cheapest and most fundamental first.
   *
   * A 6-vs-5 mismatch between these two has already cost a 500 and a two-hour outbox retry here, and
   * tsc cannot see the database's side of it.
   */
  const pg = await prisma.$queryRaw`
    SELECT e.enumlabel AS label FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'InvoiceSeries' ORDER BY e.enumsortorder`;
  const dbSeries = pg.map((r) => r.label);
  check('the TypeScript series union matches the database enum exactly',
    JSON.stringify([...NUM.INVOICE_SERIES].sort()) === JSON.stringify([...dbSeries].sort()),
    `ts=[${[...NUM.INVOICE_SERIES].join(' ')}]  pg=[${dbSeries.join(' ')}]`);

  console.log('\n— FOUR SERIES, FOUR PREFIXES, NO FALLTHROUGH —');
  const profile = {
    invoice_prefix: 'INV', invoice_warranty_prefix: 'W', invoice_historical_prefix: 'H',
    invoice_vehicle_sale_prefix: 'VS', invoice_pad_width: 4, invoice_fy_digits: 2, fy_start_month: 4,
  };
  // NEVER THROWS: a series with no entry reports as MISSING and fails the clause below, rather than
  // ending the run before the rest of the gate exists.
  const prefixOf = (name) => { try { return NUM.prefixForSeries(name, profile); } catch { return 'MISSING'; } };
  const prefixes = NUM.INVOICE_SERIES.map(prefixOf);
  check('every series names its own prefix, and none is missing one',
    new Set(prefixes).size === NUM.INVOICE_SERIES.length && !prefixes.includes('MISSING'),
    NUM.INVOICE_SERIES.map((s, i) => `${s}=${prefixes[i]}`).join(', '));
  /**
   * THE FALLTHROUGH THIS REPLACED. The prefix was a ternary chain ending in `invoice_prefix`, so a
   * series it did not name rendered under the CHARGEABLE prefix while burning its own counter — a
   * document that reads as a garage invoice and is numbered from somewhere else.
   */
  check('  …and a car sale does NOT render under the garage prefix',
    NUM.prefixForSeries('vehicle_sale', profile) === 'VS' && NUM.prefixForSeries('vehicle_sale', profile) !== profile.invoice_prefix,
    'nobody would find that from the number');

  console.log('\n— THE COUNTER IS ITS OWN, AND ROLLS BACK WITH THE TRANSACTION —');
  const before = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP },
    select: { last_value: true, warranty_last_value: true, historical_last_value: true, vehicle_sale_last_value: true } });
  /**
   * EVERY ASSERTION INSIDE ONE TRANSACTION THAT THEN THROWS. It proves three things at once and
   * BURNS NOTHING: a number minted and rolled back must leave no gap, which is the legal guarantee
   * the whole numbering rests on.
   */
  let inside = null;
  await prisma.$transaction(async (tx) => {
    const g = await tx.group.findUnique({ where: { id: ZZ_GROUP }, select: {
      invoice_prefix: true, invoice_warranty_prefix: true, invoice_historical_prefix: true,
      invoice_vehicle_sale_prefix: true, invoice_pad_width: true, invoice_fy_digits: true, fy_start_month: true } });
    const one = await NUM.mintSeriesNumber(tx, ZZ_GROUP, 'vehicle_sale', g, new Date('2026-09-16T10:00:00Z'));
    const two = await NUM.mintSeriesNumber(tx, ZZ_GROUP, 'vehicle_sale', g, new Date('2026-09-16T10:00:00Z'));
    const seq = await tx.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP },
      select: { last_value: true, warranty_last_value: true, historical_last_value: true, vehicle_sale_last_value: true } });
    inside = { one, two, seq, prefix: g.invoice_vehicle_sale_prefix };
    throw new Error('ROLLBACK_ON_PURPOSE');
  }).catch((e) => { if (!/ROLLBACK_ON_PURPOSE/.test(String(e?.message))) throw e; });

  check('two mints in a row are consecutive', inside && inside.two.sequenceValue === inside.one.sequenceValue + 1,
    `${inside?.one.sequenceValue} then ${inside?.two.sequenceValue}`);
  check('  …and the rendered number carries the vehicle-sale prefix',
    !!inside && inside.one.number.startsWith(inside.prefix), inside?.one.number);
  check('selling a car does NOT advance the garage’s chargeable counter',
    !!inside && inside.seq.last_value === before.last_value,
    `chargeable ${before?.last_value} → ${inside?.seq.last_value} — this is the whole reason the counter is separate`);
  check('  …nor the warranty counter', !!inside && inside.seq.warranty_last_value === before.warranty_last_value);
  check('  …nor the historical counter', !!inside && inside.seq.historical_last_value === before.historical_last_value);
  check('  …while its own counter did move', !!inside && inside.seq.vehicle_sale_last_value === before.vehicle_sale_last_value + 2,
    `${before?.vehicle_sale_last_value} → ${inside?.seq.vehicle_sale_last_value}`);

  const after = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP },
    select: { vehicle_sale_last_value: true } });
  /** NO GAP. A number minted inside a transaction that fails must never have existed. */
  check('a rolled-back mint leaves the counter exactly where it was',
    after.vehicle_sale_last_value === before.vehicle_sale_last_value,
    `${before?.vehicle_sale_last_value} before, ${after?.vehicle_sale_last_value} after — a burned number with no document IS a gap`);

  console.log('\n— WHICH VAT TREATMENT, AND IT TAKES BOTH FACTS —');
  check('a MARGIN car sold is a margin supply', S.vatPositionFor('sold', 'margin') === 'margin');
  check('a QUALIFYING car sold is not', S.vatPositionFor('sold', 'qualifying') === 'qualifying',
    S.vatPositionFor('sold', 'qualifying'));
  check('  …and the same holds for a trade-out', S.vatPositionFor('traded_out', 'qualifying') === 'qualifying');
  check('scrapped is no supply, whatever it was bought as',
    S.vatPositionFor('scrapped', 'margin') === 'none' && S.vatPositionFor('scrapped', 'qualifying') === 'none');
  check('  …and so is returned', S.vatPositionFor('returned', 'qualifying') === 'none');
  check('own use stays UNSETTLED under either scheme',
    S.vatPositionFor('own_use', 'margin') === 'unsettled' && S.vatPositionFor('own_use', 'qualifying') === 'unsettled',
    'a deemed supply whose treatment we cannot state — any figure would be believed');
  /**
   * THE CLAUSE THE FIX EXISTS FOR. Same car, same price, two schemes — and the kind alone cannot
   * tell them apart. Before this, both answered 'margin'.
   */
  check('the scheme CHANGES the answer for an identical sale',
    S.vatPositionFor('sold', 'margin') !== S.vatPositionFor('sold', 'qualifying'),
    'the disposal kind alone used to decide this, and was wrong for every qualifying car');

  console.log('\n— TWO BASES, AND ONLY ONE OF THEM HAS A FLOOR —');
  const marginProfit = S.bookRow({ purchasePence: 500_00, vatStatus: 'margin', disposal: { kind: 'sold', salePence: 800_00 } });
  const qualProfit = S.bookRow({ purchasePence: 500_00, vatStatus: 'qualifying', disposal: { kind: 'sold', salePence: 800_00 } });
  check('a margin car owes a sixth of the MARGIN', marginProfit.vatDuePence === Math.round(300_00 / 6), gbp(marginProfit.vatDuePence));
  check('a qualifying car owes a sixth of the WHOLE PRICE', qualProfit.vatDuePence === Math.round(800_00 / 6), gbp(qualProfit.vatDuePence));
  check('  …so the two differ on the same sale', marginProfit.vatDuePence !== qualProfit.vatDuePence,
    `${gbp(marginProfit.vatDuePence)} vs ${gbp(qualProfit.vatDuePence)} — the old rule gave both the first figure`);

  const marginLoss = S.bookRow({ purchasePence: 800_00, vatStatus: 'margin', disposal: { kind: 'sold', salePence: 500_00 } });
  const qualLoss = S.bookRow({ purchasePence: 800_00, vatStatus: 'qualifying', disposal: { kind: 'sold', salePence: 500_00 } });
  check('a margin car at a loss owes nothing', marginLoss.vatDuePence === 0 && marginLoss.marginPence === -300_00,
    `${gbp(marginLoss.vatDuePence)} on a ${gbp(marginLoss.marginPence)} loss`);
  /**
   * NOT FLOORED. The input tax was reclaimed when the car was bought; a bad sale does not undo that.
   * Flooring this on the margin would be the margin-car arithmetic under another name.
   */
  check('a QUALIFYING car at a loss still owes VAT on the full price',
    qualLoss.vatDuePence === Math.round(500_00 / 6),
    `${gbp(qualLoss.vatDuePence)} on a ${gbp(qualLoss.marginPence)} loss — the floor belongs to the margin scheme alone`);
  check('  …and the book still reports the real loss under both schemes',
    marginLoss.marginPence === -300_00 && qualLoss.marginPence === -300_00);

  /** THE SIGNATURE, not a convention: a caller that forgets the scheme cannot compile. */
  const { readFileSync } = await import('node:fs');
  const stockSrc = readFileSync('/Users/hugh/Developer/greasedesk-core/lib/stock.ts', 'utf8');
  const sig = stockSrc.slice(stockSrc.indexOf('export function vatPositionFor'), stockSrc.indexOf(')', stockSrc.indexOf('export function vatPositionFor')));
  // @anchored-ok: a TYPESCRIPT TYPE ANNOTATION, not a data key — `vatStatus: VatStatus` is a parameter and its type, and the clause is about the absent `= default`; hasKey matches the name alone and says nothing about either
  check('vatStatus is a REQUIRED argument, with no default', /vatStatus: VatStatus/.test(sig) && !/vatStatus[^,)]*=/.test(sig),
    'a default would put the wrong answer back silently');
  const bookSig = stockSrc.slice(stockSrc.indexOf('export function bookRow'), stockSrc.indexOf('}): BookRow'));
  // @anchored-ok: the same TYPE ANNOTATION, a required property in bookRow's argument object — the clause is about the `?` NOT being there, a fact about the type rather than about any key's presence
  check('  …and bookRow demands it too', /vatStatus: VatStatus;/.test(bookSig) && !/vatStatus\?/.test(bookSig));
  check('  …while bookRow STILL cannot see costs', !/cost/i.test(bookSig),
    'the scheme was added without opening the door prep costs were kept out of');

  console.log('\n— THE COLUMNS ARE THERE AND HONEST —');
  const cols = await prisma.$queryRaw`
    SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
    WHERE (table_name, column_name) IN (('Invoice','vat_position'), ('Group','invoice_vehicle_sale_prefix'), ('InvoiceSequence','vehicle_sale_last_value'))`;
  const col = (t, c) => cols.find((r) => r.table_name === t && r.column_name === c);
  check('Invoice.vat_position exists and is NULLABLE', col('Invoice', 'vat_position')?.is_nullable === 'YES',
    'null on every garage invoice, which is all of them today');
  check('Group.invoice_vehicle_sale_prefix defaults so no tenant is left without one',
    /VS/.test(col('Group', 'invoice_vehicle_sale_prefix')?.column_default ?? ''), col('Group', 'invoice_vehicle_sale_prefix')?.column_default);
  check('InvoiceSequence.vehicle_sale_last_value starts at zero',
    /0/.test(col('InvoiceSequence', 'vehicle_sale_last_value')?.column_default ?? ''), col('InvoiceSequence', 'vehicle_sale_last_value')?.column_default);
  const stray = await prisma.invoice.count({ where: { series: 'vehicle_sale' } });
  check('no vehicle_sale invoice exists yet — the mint lands in the next step', stray === 0, `${stray}`);

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
