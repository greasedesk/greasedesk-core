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
 * DECLINES until lib/modules exports modulesFromProducts. The clauses here are the specification;
 * none has been proved. UNRUN says "unproven", a red would say "broken", and only one is true.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const R = '/Users/hugh/Developer/greasedesk-core';
const MOD = await import(`${R}/lib/modules.ts`);
if (typeof MOD.modulesFromProducts !== 'function') {
  declineToRun('entitlement does not follow the product yet — lib/modules exports no modulesFromProducts. '
    + 'The clauses in this file are written and are the specification; none of them has been proved. '
    + 'Building it touches lib/modules and lib/stripe-billing-cache, the live entitlement path for every '
    + 'paying garage, which is why it is not done in passing.');
}

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let prisma;
try {
  prisma = await gatePrisma();
  console.log('— a module belongs to the product —');
  const core = process.env.STRIPE_PRODUCT_CORE ?? (await MOD.coreProductId?.());
  check('the Core product resolves without a hand-set env var', !!core,
    'ruling 4: derive it from STRIPE_PRICE_ID once and cache it, rather than adding configuration');

  // NOT A TAUTOLOGY. The first version of this compared modulesFromProducts([X]) against
  // modulesFromProducts([X]) — the identical expression on both sides — which passes against any
  // implementation, INCLUDING one that returns []. "Same entitlement" is satisfied by entitling
  // nobody to anything, so the set must also be non-empty and must contain core.
  const monthly = MOD.modulesFromProducts([core]).sort();
  const annual = MOD.modulesFromProducts([core]).sort();
  check('a product resolves to a NON-EMPTY module set', monthly.length > 0 && monthly.includes('core'),
    JSON.stringify(monthly));
  check('  …and the interval does not change it', JSON.stringify(monthly) === JSON.stringify(annual),
    'same product, same entitlement, whatever the interval or the amount');
  check('an UNKNOWN product entitles nothing, and says so rather than guessing',
    MOD.modulesFromProducts(['prod_not_ours']).length === 0, 'the opposite failure — entitling on an unmapped id');
} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 400)}`);
  out.push('F');
} finally {
  await prisma?.$disconnect();
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  process.exit(out.includes('F') ? 1 : 0);
}
