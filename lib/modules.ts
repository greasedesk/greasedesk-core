/**
 * File: lib/modules.ts
 * THE module-entitlement chokepoint. "Is this tenant entitled to X?" is answered here and NOWHERE
 * else — never an inline GroupFeature query, never a scattered boolean. Same discipline as
 * lib/billing::canWrite and lib/admin-guard.
 *
 * ── SOURCE OF TRUTH ───────────────────────────────────────────────────────────────────────────────
 * STRIPE decides what a tenant is entitled to; GroupFeature is a DERIVED CACHE (exactly as
 * GroupBilling.subscription_status is). The one writer — lib/stripe-billing-cache —
 * derives the module set from the subscription's Price IDs and writes billing status AND modules
 * together, from the SAME subscription object, in one transaction. Two facts written by one writer
 * from one source cannot disagree, so the price a tenant pays and the modules they get cannot drift.
 * Nothing else may write a `stripe`-sourced row.
 *
 * An operator override is a `grant` row: deliberately marked, visible as an override, and NOT
 * overwritten by Stripe sync (comped accounts, beta access, migrations survive a renewal).
 *
 * ── PACKAGING (re-cut 2026-07-29, two tiers) ──────────────────────────────────────────────────────
 *   core  — everything built today (diary, job cards, quotes, invoicing, dashboard, HR, capacity,
 *           PWA, staff-applied promo codes). NEVER gateable: `hasModule('core')` is always true.
 *   web   — the £150 tier as ONE SKU: white-label site, SEO, CUSTOMER-FACING online booking and
 *           customer-facing promo codes. Nothing implements it yet, so nothing gates on it yet.
 *
 * THE LESSON THAT COST US (the live tenant lost diary booking for a day): a module key must name a
 * SELLABLE SURFACE, never a verb the garage's own staff already do. The retired `booking` key was
 * pointed at /api/diary PATCH — a garage moving its own job between its own lifts — which is Core.
 * `promos` had the identical trap waiting: staff discount codes on a quote are Core; promo codes on
 * the public booking site are Web. Both keys are retired; their rows on existing tenants are inert.
 *
 * ── THE MAP IS CONFIGURATION, NOT CODE ────────────────────────────────────────────────────────────
 * Price IDs come from env, so the same build serves sandbox and live. An unmapped Price ID is
 * IGNORED for entitlement (and logged) — never guessed at.
 */
import { prisma } from '@/lib/db';

export const MODULES = ['core', 'web', 'inbound'] as const;
export type ModuleKey = typeof MODULES[number];

export const isModuleKey = (k: string): k is ModuleKey => (MODULES as readonly string[]).includes(k);

/** Human labels for the Engine Room / billing surfaces. */
export const MODULE_LABELS: Record<ModuleKey, string> = {
  core: 'Core',
  web: 'Web', // white-label site, SEO, customer-facing online booking, customer-facing promo codes
  inbound: 'Inbound email', // customer replies arrive in GreaseDesk instead of the garage's inbox
};

/**
 * CLOSED BY DEFAULT, against the open-by-default rule above, and deliberately so. Enabling inbound
 * changes where a garage's customer replies LAND: resolveReplyTo starts handing out the inbound
 * address instead of their own. Defaulting that to ON for every unseeded tenant would silently
 * redirect real customer mail away from the mailbox their staff watch. Absence of a row must mean
 * "not switched on", not "switched on because nobody said otherwise".
 */
export const CLOSED_BY_DEFAULT: ReadonlySet<string> = new Set(['inbound']);

/**
 * OPEN BY DEFAULT, deliberately, for now. Nothing is on sale as a module yet; a tenant with no row
 * must never lose a working feature. This is the single line to flip when the Web tier goes on
 * sale — one constant, one file, and unseeded tenants become closed rather than open. (Mirrors
 * lib/billing's safe-by-default stance: the gate bites only when something explicitly says no.)
 */
export const MODULE_DEFAULT_WHEN_UNSET = true;

/** Price ID → module key, from env. Configuration, so sandbox/live differ without a rebuild. */
export function priceIdModuleMap(): Record<string, ModuleKey> {
  const map: Record<string, ModuleKey> = {};
  const add = (id: string | undefined, key: ModuleKey) => { if (id) map[id] = key; };
  add(process.env.STRIPE_PRICE_CORE ?? process.env.STRIPE_PRICE_ID, 'core'); // THE multi-currency Core price
  add(process.env.STRIPE_PRICE_WEB, 'web'); // the £150 tier — one SKU, one key (not yet created)
  return map;
}

/**
 * The module set a Stripe subscription entitles, derived from its line items' Price IDs.
 *
 * SUPERSEDED BY modulesFromProducts FOR THE LIVE PATH (2026-10-28), and kept because it is the
 * ONLY thing that can answer "what did entitlement say before the change" — the clause proving
 * existing subscribers were unaffected compares the two against one recorded subscription. A
 * second implementation is a liability unless something reads it; this one is read by the gate.
 */
export function modulesFromPriceIds(priceIds: string[]): ModuleKey[] {
  const map = priceIdModuleMap();
  const out = new Set<ModuleKey>();
  for (const id of priceIds) {
    const key = map[id];
    if (key) out.add(key);
    else if (id) console.warn(`[modules] unmapped Stripe price ${id} — ignored for entitlement`);
  }
  return [...out];
}

// ── A MODULE BELONGS TO THE PRODUCT, NOT TO THE PRICE (2026-10-28) ───────────────────────────────
// Annual amounts are inline `price_data` derived from the Engine Room settings, so that changing
// months-paid never means creating a Stripe Price by hand. An inline price has a GENERATED id that
// is in no map — and the price-based lookup above answers an unmapped id with a console.warn and
// NO modules. A garage paying £750 for Core, entitled to nothing, with a log line as the only
// witness. The product is the thing being sold; the price is only what it cost this garage, and
// monthly and annual are two prices for one product precisely so they give identical access.

/** Product ID → module key. The Core product is DERIVED (see coreProductId), not configured. */
export function productIdModuleMap(coreProductId: string | null): Record<string, ModuleKey> {
  const map: Record<string, ModuleKey> = {};
  const add = (id: string | null | undefined, key: ModuleKey) => { if (id) map[id] = key; };
  add(process.env.STRIPE_PRODUCT_CORE ?? coreProductId, 'core');
  add(process.env.STRIPE_PRODUCT_WEB, 'web'); // not created yet; present so the shape is one line
  return map;
}

/**
 * The module set a subscription entitles, from its line items' PRODUCT ids.
 *
 * An unmapped product entitles NOTHING, and that is the opposite failure to the one above: an
 * unmapped PRICE now means "an amount we generated for a product we do sell", while an unmapped
 * PRODUCT means "something we do not sell". Guessing on the second would hand out access on any
 * id Stripe happened to send. Both rules are needed and they are not the same rule.
 */
export function modulesFromProducts(productIds: (string | null | undefined)[], coreProductId: string | null = null): ModuleKey[] {
  const map = productIdModuleMap(coreProductId);
  const out = new Set<ModuleKey>();
  for (const id of productIds) {
    if (!id) continue;
    const key = map[id];
    if (key) out.add(key);
    else console.warn(`[modules] unmapped Stripe product ${id} — entitles nothing`);
  }
  return [...out];
}

/**
 * THE CORE PRODUCT, DERIVED FROM THE PRICE WE ALREADY CONFIGURE — not a new env var.
 *
 * Owner ruling 4 (2026-10-24) was that changing a number in the Engine Room must not mean touching
 * Stripe by hand; adding STRIPE_PRODUCT_CORE to four environments would be the same shape of
 * obligation, and a second id that must agree with the first is a thing that can disagree. So it
 * is read ONCE from STRIPE_PRICE_ID's own `product` field and cached for the life of the process.
 *
 * A FAILED LOOKUP IS NOT CACHED, for the same reason lib/environment does not cache one: a Stripe
 * blip at boot would otherwise entitle nobody for as long as the lambda lives. STRIPE_PRODUCT_CORE
 * remains as an override for the case where somebody must pin it, which is why the map reads it
 * first — it is an escape hatch, not the normal path.
 */
let _coreProduct: string | null = null;
export async function coreProductId(): Promise<string | null> {
  const pinned = process.env.STRIPE_PRODUCT_CORE;
  if (pinned) return pinned;
  if (_coreProduct) return _coreProduct;
  const { getStripe, stripePriceId } = await import('@/lib/stripe');
  const stripe = getStripe();
  const priceId = stripePriceId();
  if (!stripe || !priceId) return null;
  try {
    const price = await stripe.prices.retrieve(priceId);
    const product = typeof price.product === 'string' ? price.product : price.product?.id ?? null;
    if (product) _coreProduct = product;
    return product;
  } catch (e: any) {
    console.error('[modules] could not resolve the Core product from the monthly price —', e?.message);
    return null; // NOT cached
  }
}

/** Test seam: forget the cached product id. Used by the gate, never by application code. */
export function __resetCoreProductCache(): void { _coreProduct = null; }

/** Every module row for a tenant, as a map. Enabled-only is what hasModule uses. */
export async function getModules(groupId: string): Promise<Record<string, boolean>> {
  const rows = await prisma.groupFeature.findMany({
    where: { group_id: groupId },
    select: { feature_key: true, enabled: true },
  });
  return Object.fromEntries(rows.map((r: { feature_key: string; enabled: boolean }) => [r.feature_key, r.enabled]));
}

/**
 * THE read. Every gated surface calls this — server-side, always.
 * A missing row falls back to MODULE_DEFAULT_WHEN_UNSET (open today, see above).
 */
export async function hasModule(groupId: string | null | undefined, moduleKey: ModuleKey): Promise<boolean> {
  if (!groupId) return false;
  if (moduleKey === 'core') return true; // Core is the product; it is never gateable
  try {
    const row = await prisma.groupFeature.findUnique({
      where: { group_id_feature_key: { group_id: groupId, feature_key: moduleKey } },
      select: { enabled: true },
    });
    if (row) return row.enabled;
    // A key in CLOSED_BY_DEFAULT is off until something explicitly turns it on.
    return CLOSED_BY_DEFAULT.has(moduleKey) ? false : MODULE_DEFAULT_WHEN_UNSET;
  } catch {
    // A lookup failure must not lock a paying tenant out of what they already have — but it must
    // also never switch on something that redirects their mail.
    return CLOSED_BY_DEFAULT.has(moduleKey) ? false : MODULE_DEFAULT_WHEN_UNSET;
  }
}

/**
 * API guard. A disabled module must REFUSE at the server — hiding the link is not a guard.
 * Returns true when the caller may proceed; when false it has ALREADY sent 403 and the handler
 * must return immediately.
 */
export async function requireModuleApi(
  res: { status: (c: number) => { json: (b: any) => any } },
  groupId: string | null | undefined,
  moduleKey: ModuleKey,
): Promise<boolean> {
  if (await hasModule(groupId, moduleKey)) return true;
  res.status(403).json({
    message: `${MODULE_LABELS[moduleKey]} isn’t included in your plan.`,
    code: 'MODULE_NOT_ENABLED',
    module: moduleKey,
  });
  return false;
}

/**
 * Write the STRIPE-DERIVED module set for a tenant. Called ONLY by lib/stripe-billing-cache, in the
 * same transaction as the billing-status write. `grant` rows are left alone — an operator override
 * must survive a renewal — and modules absent from the subscription are switched OFF (a downgrade
 * has to actually take effect), never deleted, so the history of what was on stays legible.
 */
export async function applyStripeModules(
  tx: { groupFeature: { upsert: Function; updateMany: Function } },
  groupId: string,
  entitled: ModuleKey[],
): Promise<void> {
  const on = new Set(entitled);
  for (const key of MODULES) {
    if (key === 'core') continue; // never gated, never written from Stripe
    await tx.groupFeature.upsert({
      where: { group_id_feature_key: { group_id: groupId, feature_key: key } },
      create: { group_id: groupId, feature_key: key, enabled: on.has(key), source: 'stripe' },
      // Only overwrite rows Stripe owns — a `grant` override is deliberate and outranks the sub.
      update: {},
    });
    // Stripe owns ONLY its own rows (ruling 2026-07-29). `default` was in this set, so the
    // pre-sale "every existing tenant keeps everything" seed expired at the tenant's next webhook —
    // which is exactly how the live tenant lost diary booking. A seeded default is now as durable
    // as a manual grant; both outrank the subscription until deliberately changed.
    await tx.groupFeature.updateMany({
      where: { group_id: groupId, feature_key: key, source: 'stripe' },
      data: { enabled: on.has(key), source: 'stripe' },
    });
  }
}
