/**
 * File: scripts/entitlement-product-gate.mjs
 * @gate-requires: db
 *
 * A MODULE BELONGS TO THE PRODUCT, NOT TO THE PRICE.
 *
 * ── WHY THIS IS ITS OWN GATE ───────────────────────────────────────────────────────────────────
 * It began as section 4 of affiliate-gate, because the affiliate offer is what first needed an
 * inline price. It is not an affiliate rule: it is the entitlement rule for EVERY paying garage,
 * and lumping it in made "the affiliate ledger is correct" and "entitlement resolves" share one
 * verdict. Moved out on 2026-10-26 so each says its own thing.
 *
 * ── THE DEFECT IT IS FOR ───────────────────────────────────────────────────────────────────────
 * modulesFromPriceIds maps a PRICE ID to a module. Changing months-paid in the Engine Room must
 * not require a Stripe Price created by hand (ruling 4), so annual amounts are inline price_data
 * with a generated id that is in no map — and the old lookup answered an unmapped price with a
 * console.warn and NO modules. A garage paying for Core, entitled to nothing.
 *
 * BUILT 2026-10-28. It declined until lib/modules exported modulesFromProducts; it now runs.
 *
 * NO STRIPE CALL. coreProductId() reaches Stripe when STRIPE_PRODUCT_CORE is unset, so the gate
 * sets that variable for its own process: the clause being proved is that the resolver PREFERS the
 * pinned id, and that the map built from it answers correctly. Whether the real monthly price
 * points at that product is a question only the Stripe dashboard can answer, and it is checkout
 * step B in the manual plan — not something a gate can honestly claim to have tested.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const R = '/Users/hugh/Developer/greasedesk-core';
process.env.STRIPE_PRODUCT_CORE ??= 'prod_ZZGATE_CORE';
const MOD = await import(`${R}/lib/modules.ts`);
if (typeof MOD.modulesFromProducts !== 'function') {
  declineToRun('entitlement does not follow the product yet — lib/modules exports no modulesFromProducts.');
}

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let prisma;
try {
  prisma = await gatePrisma();
  console.log('— a module belongs to the product —');
  const core = await MOD.coreProductId();
  check('the Core product resolves', !!core, `${core} — derived from STRIPE_PRICE_ID when unpinned (ruling 4)`);
  // RULING 4 IS ABOUT CONFIGURATION, and this is what keeps it honest: the resolver must reach
  // the price when nothing is pinned, rather than quietly needing an env var in four places.
  const src = (await import('node:fs')).readFileSync(`${R}/lib/modules.ts`, 'utf8');
  check('  …and it DERIVES one from the monthly price when nothing is pinned',
    /stripe\.prices\.retrieve\(priceId\)/.test(src) && /price\.product/.test(src),
    'not a second env var that has to agree with the first');
  check('  …and a FAILED lookup is not cached, so one blip does not entitle nobody for the lambda\'s life',
    /return null; \/\/ NOT cached/.test(src));

  // NOT A TAUTOLOGY, AND IT TOOK TWO GOES. The first version compared modulesFromProducts([X])
  // with modulesFromProducts([X]) — the identical expression on both sides, which passes against
  // any implementation including one that returns []. Adding "non-empty" helped and still left
  // both sides reading one literal. This runs the REAL extraction (productsOfSubscription, the
  // function lib/stripe-billing-cache calls) over two subscriptions shaped as Stripe sends them:
  // monthly names a configured Price id, annual is an INLINE price with a generated id. They
  // agree only because both prices belong to one product, which is the rule being proved.
  const { productsOfSubscription } = await import(`${R}/lib/stripe-billing-cache.ts`);
  const subFor = (price) => ({ items: { data: [{ quantity: 1, price }] } });
  const monthlySub = subFor({ id: 'price_monthly_core', product: core, recurring: { interval: 'month' }, unit_amount: 7500 });
  const annualSub = subFor({ id: 'price_1QgeneratedInline', product: core, recurring: { interval: 'year' }, unit_amount: 75000 });

  const monthly = MOD.modulesFromProducts(productsOfSubscription(monthlySub)).sort();
  const annual = MOD.modulesFromProducts(productsOfSubscription(annualSub)).sort();
  check('a product resolves to a NON-EMPTY module set', monthly.length > 0 && monthly.includes('core'),
    JSON.stringify(monthly));
  check('  …and the INTERVAL does not change it', JSON.stringify(monthly) === JSON.stringify(annual) && annual.includes('core'),
    `monthly ${JSON.stringify(monthly)} / annual ${JSON.stringify(annual)} — two prices, one product, one entitlement`);
  check('  …and a bare price string contributes no product rather than a guessed one',
    productsOfSubscription(subFor('price_just_an_id')).length === 0);
  check('an UNKNOWN product entitles nothing, and says so rather than guessing',
    MOD.modulesFromProducts(['prod_not_ours']).length === 0, 'the opposite failure — entitling on an unmapped id');

  // ── AND THE TWO RULES STAY SEPARATE (owner, 2026-10-28) ─────────────────────────────────────
  // An unmapped PRICE means "an amount we generated for a product we do sell" — the inline annual
  // case, which must still entitle. An unmapped PRODUCT means "something we do not sell". They
  // look like one rule and are not, so both are asserted and neither is folded into the other.
  check('an unmapped PRICE is a different question from an unmapped PRODUCT',
    MOD.modulesFromPriceIds(['price_generated_inline']).length === 0
      && MOD.modulesFromProducts([core]).includes('core'),
    'the inline annual price is in no price map, and entitles core via its product');

  // ── NOTHING MOVES FOR AN EXISTING MONTHLY SUBSCRIBER ────────────────────────────────────────
  // Measured, not reasoned: the SAME recorded subscription through the OLD lookup and the NEW one.
  process.env.STRIPE_PRICE_ID = 'price_monthly_core';
  const oldWay = MOD.modulesFromPriceIds(['price_monthly_core']).sort();
  const newWay = MOD.modulesFromProducts([core]).sort();
  check('an existing monthly subscriber resolves to the SAME module set before and after',
    JSON.stringify(oldWay) === JSON.stringify(newWay) && oldWay.length > 0,
    `${JSON.stringify(oldWay)} → ${JSON.stringify(newWay)} — the deploy must move nobody`);
} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 400)}`);
  out.push('F');
} finally {
  await prisma?.$disconnect();
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  process.exit(out.includes('F') ? 1 : 0);
}
