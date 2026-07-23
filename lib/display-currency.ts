/**
 * File: lib/display-currency.ts
 * The tenant's DISPLAY currency + locale for admin money surfaces that aren't already invoice- or
 * site-scoped (HR, overheads, products, promotions). Read from the caller's PRIMARY site
 * (Site.currency_code / Site.locale) — the same per-site source formatMoney uses everywhere else.
 * GB defaults when no site resolves. Thread the result into formatMoney({ currency, locale }).
 */
import { prisma } from '@/lib/db';

export async function displayCurrency(primarySiteId: string | null | undefined): Promise<{ currency: string; locale: string }> {
  const site = primarySiteId
    ? ((await prisma.site.findUnique({ where: { id: primarySiteId }, select: { currency_code: true, locale: true } })) as { currency_code: string; locale: string } | null)
    : null;
  return { currency: site?.currency_code ?? 'GBP', locale: site?.locale ?? 'en-GB' };
}
