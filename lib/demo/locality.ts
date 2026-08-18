/**
 * File: lib/demo/locality.ts
 * WHERE A DEMO TENANT IS. Derived from its name, not fixed in the calibration profile.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * `TOWN` was a constant in lib/demo/profile.ts, so EVERY generated tenant got a site called
 * "Marketbridge Workshop" regardless of its own name. On 2026-08-18 that cost a real diagnosis: two
 * failed sends were read as belonging to the new Kingsford demo when they were Marketbridge's,
 * because both tenants presented an identically named site. The wrong tenant was invisible, not
 * merely unlabelled — the screen offered nothing that could have distinguished them.
 *
 * That is the general defect: an identifier shared by two subjects cannot identify either. The site
 * name now follows the tenant, so the same mistake announces itself.
 *
 * ── AND WHY IT IS NOT IN profile.ts ─────────────────────────────────────────────────────────────
 * scripts/demo-profile-extract.mjs REWRITES that file wholesale from TMBS. Logic placed there is
 * deleted by the next extract. profile.ts holds measured inputs; this holds a rule.
 */

/** The profile's own locality, kept as the fallback so an unnamed demo generates exactly as before. */
import { TOWN as PROFILE_TOWN, POSTCODE_AREA as PROFILE_AREA } from '@/lib/demo/profile';

/**
 * REAL UK POSTCODE AREAS. The demo's streets are invented and its town is invented; the postcode
 * district is real-SHAPED but must not be a real one, or generated customers acquire addresses in
 * a place that exists. 'MB' was chosen because it is not a real area — that property has to survive
 * derivation, so it is checked rather than assumed.
 */
const REAL_UK_AREAS = new Set([
  'AB', 'AL', 'B', 'BA', 'BB', 'BD', 'BH', 'BL', 'BN', 'BR', 'BS', 'BT', 'CA', 'CB', 'CF', 'CH',
  'CM', 'CO', 'CR', 'CT', 'CV', 'CW', 'DA', 'DD', 'DE', 'DG', 'DH', 'DL', 'DN', 'DT', 'DY', 'E',
  'EC', 'EH', 'EN', 'EX', 'FK', 'FY', 'G', 'GL', 'GU', 'GY', 'HA', 'HD', 'HG', 'HP', 'HR', 'HS',
  'HU', 'HX', 'IG', 'IM', 'IP', 'IV', 'JE', 'KA', 'KT', 'KW', 'KY', 'L', 'LA', 'LD', 'LE', 'LL',
  'LN', 'LS', 'LU', 'M', 'ME', 'MK', 'ML', 'N', 'NE', 'NG', 'NN', 'NP', 'NR', 'NW', 'OL', 'OX',
  'PA', 'PE', 'PH', 'PL', 'PO', 'PR', 'RG', 'RH', 'RM', 'S', 'SA', 'SE', 'SG', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SP', 'SR', 'SS', 'ST', 'SW', 'SY', 'TA', 'TD', 'TF', 'TN', 'TQ', 'TR', 'TS', 'TW',
  'UB', 'W', 'WA', 'WC', 'WD', 'WF', 'WN', 'WR', 'WS', 'WV', 'YO', 'ZE',
]);

/** Words that are the trade, not the place — dropped so "Kingsford Motor Company" yields Kingsford. */
const TRADE_WORDS = new Set([
  'motor', 'motors', 'garage', 'garages', 'workshop', 'workshops', 'autos', 'auto', 'automotive',
  'works', 'servicing', 'service', 'services', 'company', 'co', 'ltd', 'limited', 'plc', 'llp',
  'specialist', 'specialists', 'engineering', 'engineers', 'tyres', 'bodyshop', 'centre', 'center',
  'the', 'and', '&',
]);

export type Locality = { town: string; postcodeArea: string };

/**
 * The town a tenant's demo data sits in.
 *
 * `override` wins outright — an operator naming a place has decided. Otherwise the first word of the
 * group name that is not a trade word becomes the town, and the postcode area its first two letters.
 *
 * THROWS if that derivation lands on a real postcode area. A demo quietly seeding addresses in a
 * real district is exactly the kind of thing nobody notices until it matters, so it refuses and asks
 * for an explicit area rather than choosing one itself.
 */
export function localityFor(groupName: string, override?: Partial<Locality>): Locality {
  if (override?.town && override?.postcodeArea) {
    return { town: override.town, postcodeArea: override.postcodeArea.toUpperCase() };
  }
  const word = (override?.town ?? groupName)
    .split(/[^A-Za-z]+/)
    .find((w) => w.length >= 3 && !TRADE_WORDS.has(w.toLowerCase()));

  // Nothing usable in the name — fall back to the profile's own locality, unchanged.
  if (!word) return { town: PROFILE_TOWN, postcodeArea: PROFILE_AREA };

  const town = word[0].toUpperCase() + word.slice(1);
  // The profile's own town keeps the profile's own area, so a default generation is byte-for-byte
  // what it was before this module existed.
  if (town === PROFILE_TOWN && !override?.postcodeArea) return { town, postcodeArea: PROFILE_AREA };

  const area = (override?.postcodeArea ?? town.slice(0, 2)).toUpperCase();
  if (REAL_UK_AREAS.has(area)) {
    throw new Error(
      `DEMO_LOCALITY_REAL_POSTCODE_AREA: "${town}" derives postcode area ${area}, which is a real UK `
      + `area. Demo addresses must not land in a real district — pass an explicit postcodeArea.`,
    );
  }
  return { town, postcodeArea: area };
}
