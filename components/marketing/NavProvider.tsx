/**
 * File: components/marketing/NavProvider.tsx
 * Carries the resolved marketing nav (footer + main) from _app (SSR-resolved) to SiteChrome, so the
 * footer and nav render from the Content-system config instead of hardcoded lists. Falls back to
 * FALLBACK_NAV if nothing is provided, so the site never renders an empty nav.
 */
import { createContext, useContext } from 'react';
import { FALLBACK_NAV, type PublicNavLink, type NavPlacement } from '@/lib/nav';

export type ResolvedNav = Record<NavPlacement, PublicNavLink[]>;
const Ctx = createContext<ResolvedNav>(FALLBACK_NAV);
export const useNav = (): ResolvedNav => useContext(Ctx);

export function NavProvider({ value, children }: { value: ResolvedNav | null | undefined; children: React.ReactNode }) {
  return <Ctx.Provider value={value ?? FALLBACK_NAV}>{children}</Ctx.Provider>;
}
