/**
 * File: lib/cost-allocation.ts
 * THE one place the cost-allocation invariant lives. Every headcount/overhead write validates
 * its site allocations here — never inline. Rules:
 *   - at least one allocation row
 *   - every site_id belongs to the tenant (no cross-tenant / cross-site leak)
 *   - no duplicate site in the same cost's allocations
 *   - each percent in (0, 100]
 *   - the percents sum to exactly 100%, checked on integer BASIS POINTS so 33.33/33.33/33.34
 *     is exact and no Decimal/float drift can slip a 99.999% past the gate.
 * Storage grain is pennies (Int) for money and Decimal(5,2) percent; see schema.prisma.
 */

export type AllocationInput = { siteId: string; percent: number };

export type AllocationCheck =
  | { ok: true; rows: Array<{ siteId: string; percent: number }> }
  | { ok: false; error: string };

// percent (e.g. 60.00) -> basis points (6000). Rounds to the Decimal(5,2) grain.
export const toBasisPoints = (percent: number): number => Math.round(percent * 100);

const TOTAL_BP = 10000; // 100.00%

/**
 * Validate a cost's site allocations against the tenant's own sites.
 * @param allocs      raw allocation rows from the request
 * @param tenantSiteIds  the sites this tenant (group) owns — the allow-list
 */
export function validateAllocations(allocs: unknown, tenantSiteIds: string[]): AllocationCheck {
  if (!Array.isArray(allocs) || allocs.length === 0) {
    return { ok: false, error: 'At least one site allocation is required.' };
  }
  const allow = new Set(tenantSiteIds);
  const seen = new Set<string>();
  const rows: Array<{ siteId: string; percent: number }> = [];
  let totalBp = 0;

  for (const a of allocs as AllocationInput[]) {
    const siteId = a && typeof a.siteId === 'string' ? a.siteId : '';
    const percent = a == null ? NaN : Number(a.percent);
    if (!siteId) return { ok: false, error: 'Each allocation needs a site.' };
    if (!allow.has(siteId)) return { ok: false, error: 'Allocation to a site outside your business.' };
    if (seen.has(siteId)) return { ok: false, error: 'A site appears more than once in one allocation.' };
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return { ok: false, error: 'Each percentage must be greater than 0 and at most 100.' };
    }
    seen.add(siteId);
    const bp = toBasisPoints(percent);
    totalBp += bp;
    rows.push({ siteId, percent: bp / 100 });
  }

  if (totalBp !== TOTAL_BP) {
    return { ok: false, error: 'Site allocation must total exactly 100%.' };
  }
  return { ok: true, rows };
}
