/**
 * File: lib/content-page.ts
 * getServerSideProps for public content routes — resolve the published document by slug + country
 * (exact country → GB fallback) and 404 if nothing is published (a draft is NEVER rendered publicly).
 * A single dynamic route (pages/[slug]) uses `documentPageDynamic`, so any published document gets a
 * working URL at /<slug> with NO deploy. Country is GB today; a `/ie` prefix resolves to IE.
 */
import type { GetServerSideProps, GetServerSidePropsContext } from 'next';

export type PublicDocProps = { slug: string; title: string; body: string; version: string; effectiveFrom: string | null };

async function resolve(ctx: GetServerSidePropsContext, slug: string) {
  if (!slug) return { notFound: true as const };
  const { prisma } = await import('@/lib/db');
  const { resolvePublished } = await import('@/lib/content');
  const country = /^\/ie(\/|$)/.test(ctx.resolvedUrl || '') ? 'IE' : 'GB';
  const doc = await resolvePublished(prisma, slug, country);
  if (!doc) return { notFound: true as const };
  return { props: { slug, title: doc.title, body: doc.body, version: doc.version, effectiveFrom: doc.effective_from ? doc.effective_from.toISOString().slice(0, 10) : null } };
}

/** Fixed-slug page (kept for any bespoke route). */
export function documentPage(slug: string): GetServerSideProps<PublicDocProps> {
  return async (ctx) => resolve(ctx, slug) as any;
}
/** Dynamic page — slug from the route param. */
export const documentPageDynamic: GetServerSideProps<PublicDocProps> = async (ctx) => resolve(ctx, String(ctx.params?.slug ?? '')) as any;
