/**
 * File: lib/admin-guard.ts
 * ONE chokepoint for admin-only access — built on getVisibility (single source of truth).
 *   requireAdminPage(ctx) → for getServerSideProps of admin-only pages (redirects non-admins).
 *   requireAdminApi(req,res) → for admin-only API routes (sends 401/403, returns null if blocked).
 * Use these instead of scattered inline role checks so a missed page/endpoint can't recur.
 */
import type { GetServerSidePropsContext } from 'next';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility, type Visibility } from '@/lib/site-visibility';
import { prisma } from '@/lib/db';
import { canWrite } from '@/lib/billing';
import { getOnboardingState, stepPath, type OnboardingStep } from '@/lib/onboarding';

type RedirectResult = { ok: false; redirect: { destination: string; permanent: boolean } };

/**
 * THE onboarding root gate (item-13), for the raw entry points that don't route through
 * requireAdminPage (landing, dashboard, diary, job cards, /m). Returns a redirect destination to the
 * first incomplete step, or null when the tenant is fully set up. Short-circuits inside
 * getOnboardingState — microseconds on the request path. This single call REPLACES the five
 * scattered `!site_id → setup-location` leaf patches: one gate, not five defensive checks.
 */
export async function onboardingGateRedirect(groupId: string | null | undefined): Promise<string | null> {
  const state = await getOnboardingState(groupId);
  return state.onboarded ? null : stepPath(state.firstIncompleteStep ?? 'site');
}

/**
 * THE billing write-gate for API routes (item-12). Call at the top of every endpoint that CREATES
 * NEW WORK — new job card, estimate save, issue invoice, new booking, add site. Reads the
 * webhook-maintained subscription cache; a LAPSED tenant gets 402 with the non-punitive message and
 * a Portal route. NEVER gate a read path with this — reads stay open forever, free (the ruling).
 * Returns true when the write may proceed. Safe-by-default: no subscription cache → allowed.
 */
export async function requireCanWrite(groupId: string, res: NextApiResponse): Promise<boolean> {
  const billing = await prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { subscription_status: true } });
  if (canWrite({ subscriptionStatus: billing?.subscription_status ?? null, status: null })) return true;
  res.status(402).json({
    code: 'subscription_lapsed',
    message: 'Your subscription has lapsed — your records are safe and fully exportable. Resubscribe to add new work.',
  });
  return false;
}

export async function requireAdminPage(
  ctx: GetServerSidePropsContext
): Promise<{ ok: true; vis: Visibility } | RedirectResult> {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id) return { ok: false, redirect: { destination: '/admin/login', permanent: false } };
  const vis = await getVisibility(u.id as string);
  if (!vis.isAdmin) return { ok: false, redirect: { destination: '/admin/dashboard', permanent: false } };
  // Root onboarding gate: an admin whose tenant isn't fully set up is sent to its first incomplete
  // step. Every admin page built on this guard inherits it — no per-page onboarding checks.
  const onboard = await onboardingGateRedirect(vis.groupId);
  if (onboard) return { ok: false, redirect: { destination: onboard, permanent: false } };
  return { ok: true, vis };
}

export async function requireAdminApi(req: NextApiRequest, res: NextApiResponse): Promise<Visibility | null> {
  const session = await getServerSession(req, res, authOptions);
  const u = session?.user as any;
  if (!u?.id) { res.status(401).json({ message: 'Not authenticated.' }); return null; }
  const vis = await getVisibility(u.id as string);
  if (!vis.isAdmin) { res.status(403).json({ message: 'Admin access required.' }); return null; }
  return vis;
}

/**
 * Wizard step-guard (item-13). Used by each /onboarding/* page's gssp so the wizard self-sequences:
 * you can only be ON your current step. Bounces skip-ahead (opening `tax` before `rates` → rates),
 * resumes a half-finished tenant at its first incomplete step, and sends an already-complete tenant
 * to the dashboard. Onboarding is owner/ADMIN work — non-admins are sent to the dashboard.
 */
export async function requireOnboardingStep(
  ctx: GetServerSidePropsContext,
  step: OnboardingStep,
): Promise<{ ok: true; vis: Visibility } | RedirectResult> {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id) return { ok: false, redirect: { destination: `/admin/login?callbackUrl=${encodeURIComponent(stepPath(step))}`, permanent: false } };
  const vis = await getVisibility(u.id as string);
  if (!vis.groupId) return { ok: false, redirect: { destination: '/admin/login', permanent: false } };
  if (!vis.isAdmin) return { ok: false, redirect: { destination: '/admin/dashboard', permanent: false } };
  const state = await getOnboardingState(vis.groupId);
  if (state.onboarded) return { ok: false, redirect: { destination: '/admin/dashboard', permanent: false } };
  if (state.firstIncompleteStep !== step) {
    return { ok: false, redirect: { destination: stepPath(state.firstIncompleteStep ?? 'site'), permanent: false } };
  }
  return { ok: true, vis };
}

// ---- site authority chokepoints ------------------------------------------------------
// OPERATIONAL — "can this user TOUCH this site at all?" — true for any role (incl. STANDARD
// mechanics) assigned to the site, plus site_manager/admin. Broader than canManageSite.
// Use for operational job-card actions (stage toggles, starting work).
export function canAccessSite(vis: Visibility, siteId: string | null | undefined): boolean {
  if (!siteId) return false;
  return vis.siteIds.includes(siteId);
}

// COMMERCIAL — "can this user MANAGE this site?" — ADMIN/owner on any group site, SITE_MANAGER
// on their assigned sites, NEVER STANDARD. Use for pricing / money / lifecycle decisions.
export function canManageSite(vis: Visibility, siteId: string | null | undefined): boolean {
  if (!siteId) return false;
  return vis.role !== 'STANDARD' && vis.siteIds.includes(siteId);
}

// API guard: caller must be able to manage `siteId` (admin or site-manager-for-that-site).
export async function requireManageSiteApi(req: NextApiRequest, res: NextApiResponse, siteId: string | null | undefined): Promise<Visibility | null> {
  const session = await getServerSession(req, res, authOptions);
  const u = session?.user as any;
  if (!u?.id) { res.status(401).json({ message: 'Not authenticated.' }); return null; }
  const vis = await getVisibility(u.id as string);
  if (!canManageSite(vis, siteId)) { res.status(403).json({ message: 'You do not manage this location.' }); return null; }
  return vis;
}

// SSR guard for pages open to ADMIN or SITE_MANAGER (Locations & Resources, Users). STANDARD is
// redirected to the dashboard. Returns vis so the page can branch admin-vs-manager.
export async function requireSiteManagerPage(
  ctx: GetServerSidePropsContext
): Promise<{ ok: true; vis: Visibility } | RedirectResult> {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id) return { ok: false, redirect: { destination: '/admin/login', permanent: false } };
  const vis = await getVisibility(u.id as string);
  if (vis.role === 'STANDARD') return { ok: false, redirect: { destination: '/admin/dashboard', permanent: false } };
  return { ok: true, vis };
}
