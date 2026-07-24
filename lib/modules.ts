/**
 * File: lib/modules.ts
 * THE module-entitlement chokepoint. "Does this tenant have Booking?" is answered here and NOWHERE
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
 * ── PACKAGING (decided 2026-07-24) ────────────────────────────────────────────────────────────────
 * Per-module Stripe LINE ITEMS on one subscription, not one Price per tier:
 *   core £75  +  booking £20  +  promos £10   →  the published £75 / £95 / £105 ladder.
 * Price ID → module key is 1:1, so entitlement is read straight off the subscription items and a
 * fourth module is one new Price, not a doubling of tier SKUs. Modules are INDEPENDENT — `promos`
 * does not require `booking` — so Core+Promos is a legal (if unpublished) combination.
 *
 * ── THE MAP IS CONFIGURATION, NOT CODE ────────────────────────────────────────────────────────────
 * Price IDs come from env, so the same build serves sandbox and live. An unmapped Price ID is
 * IGNORED for entitlement (and logged) — never guessed at.
 */
import { prisma } from '@/lib/db';

export const MODULES = ['core', 'booking', 'promos'] as const;
export type ModuleKey = typeof MODULES[number];

export const isModuleKey = (k: string): k is ModuleKey => (MODULES as readonly string[]).includes(k);

/** Human labels for the Engine Room / billing surfaces. */
export const MODULE_LABELS: Record<ModuleKey, string> = {
  core: 'Core',
  booking: 'Booking',
  promos: 'Promotion codes',
};

/**
 * OPEN BY DEFAULT, deliberately, for now. Modules are not on sale yet and every existing tenant was
 * seeded with all three enabled; a tenant with no row must therefore NOT lose a working feature.
 * This is the single line to flip when Booking goes on sale — one constant, one file, and unseeded
 * tenants become closed rather than open. (Mirrors lib/billing's safe-by-default stance: the gate
 * bites only when something explicitly says no.)
 */
export const MODULE_DEFAULT_WHEN_UNSET = true;

/** Price ID → module key, from env. Configuration, so sandbox/live differ without a rebuild. */
export function priceIdModuleMap(): Record<string, ModuleKey> {
  const map: Record<string, ModuleKey> = {};
  const add = (id: string | undefined, key: ModuleKey) => { if (id) map[id] = key; };
  add(process.env.STRIPE_PRICE_CORE ?? process.env.STRIPE_PRICE_ID, 'core'); // legacy single price = Core
  add(process.env.STRIPE_PRICE_BOOKING, 'booking');
  add(process.env.STRIPE_PRICE_PROMOS, 'promos');
  return map;
}

/** The module set a Stripe subscription entitles, derived from its line items' Price IDs. */
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
    return row ? row.enabled : MODULE_DEFAULT_WHEN_UNSET;
  } catch {
    return MODULE_DEFAULT_WHEN_UNSET; // a lookup failure must not lock a paying tenant out
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
    await tx.groupFeature.updateMany({
      where: { group_id: groupId, feature_key: key, source: { in: ['stripe', 'default'] } },
      data: { enabled: on.has(key), source: 'stripe' },
    });
  }
}
