/**
 * File: pages/api/onboarding/country.ts
 * POST { country } — the FIRST onboarding answer. Country drives everything downstream, so choosing
 * it configures the rest of the flow in one write:
 *   • Group.country_code = the choice (also the country-step completion signal)
 *   • Group.tax_country_code / tax_model / tax_label DERIVED from the profile (never free-typed) —
 *     so the invoice label and the tax maths can't drift from the country.
 *   • Any existing Site's currency_code + timezone are set from the profile (the site step, which
 *     runs next, inherits them; if a site doesn't exist yet the site step reads the profile).
 * A SUPPORTED country advances the wizard; an UNSUPPORTED one is stored (so the coming-soon gate can
 * render) but never satisfies onboarding — the tenant sees the waitlist gate.
 *
 * ADMISSION (ruling 2026-07-30): only an ENABLED country (lib/enabled-countries — GB today) may be
 * written. That check sits after the shape check and before every write, so a disabled country is
 * refused whether it arrives from the picker or from a direct API call. The unsupported/waitlist
 * branch below stays intact and is simply unreachable while GB is the only enabled country.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireCanWrite, requireTenantApi } from '@/lib/admin-guard';
import { getProfile, isSupportedCountry, PICKER_COUNTRIES } from '@/lib/locale-profiles';
import { isEnabledCountry } from '@/lib/enabled-countries';

const KNOWN = new Set(PICKER_COUNTRIES.map((c) => c.code));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  if (!(await requireCanWrite(scope.groupId, res))) return;

  const country = String((req.body ?? {}).country ?? '').toUpperCase();
  if (!country || !KNOWN.has(country)) return res.status(400).json({ message: 'Pick a country from the list.' });

  // ── ENABLED-COUNTRIES REFUSAL (ruling 2026-07-30) ───────────────────────────────────────────────
  // Shape check above, ADMISSION check here — a code can be a real, fully-profiled, fully-built
  // country (US, IE) and still not be one we're open in. This is the ONLY writer of
  // Group.country_code, so this one guard closes the surface, including a direct API call that
  // bypasses the picker. It refuses BEFORE any write: country_code, the ref re-prefix and the
  // derived tax identity are all left exactly as they were. Existing non-GB tenants are untouched —
  // nothing here reads or rewrites a country already recorded.
  if (!isEnabledCountry(country)) {
    return res.status(400).json({ code: 'country_not_enabled', message: 'GreaseDesk isn’t open in that country yet.' });
  }

  const supported = isSupportedCountry(country);

  // Record the choice either way — an unsupported one is what the coming-soon gate reads.
  await prisma.group.update({ where: { id: scope.groupId }, data: { country_code: country } });

  // RE-PREFIX the human account ref to the chosen country (GB-GD2153 → US-GD2153, ruling
  // 2026-07-28). The DB default mints every ref with a GB prefix before the country is known.
  // Safe: the ref is DISPLAY + audit-snapshot only — Stripe keys on group_id, links on tokens,
  // invoice numbering on its own per-group series; the numeric suffix (globally unique) is
  // untouched so @unique cannot collide. Idempotent: a re-visit with the same country no-ops.
  const grpRef = await prisma.group.findUnique({ where: { id: scope.groupId }, select: { ref: true } });
  if (grpRef?.ref && /^[A-Z]{2}-/.test(grpRef.ref) && !grpRef.ref.startsWith(`${country}-`)) {
    await prisma.group.update({ where: { id: scope.groupId }, data: { ref: `${country}${grpRef.ref.slice(2)}` } });
  }

  if (!supported) {
    return res.status(200).json({ ok: true, supported: false, country });
  }

  // Supported → derive the whole tax + trading identity from the ONE profile.
  const p = getProfile(country);
  await prisma.group.update({
    where: { id: scope.groupId },
    data: {
      tax_country_code: country,
      tax_model: p.taxModel,
      tax_label: p.taxLabel,
      // FY default for NEW tenants (ruling 2026-07-29): GB April, US/IE January. Safe to write
      // here — the country step is only reachable pre-onboarding, before the tenant could ever
      // have touched Financial settings; existing tenants' stored values are never rewritten.
      fy_start_month: p.fyStartMonth,
    },
  });
  // Prime any existing site with the country's currency + default timezone (the site step edits them).
  await prisma.site.updateMany({
    where: { group_id: scope.groupId },
    data: { currency_code: p.currency, timezone: p.defaultTimezone },
  });

  return res.status(200).json({
    ok: true, supported: true, country,
    currency: p.currency, taxModel: p.taxModel, taxLabel: p.taxLabel, defaultTimezone: p.defaultTimezone,
  });
}
