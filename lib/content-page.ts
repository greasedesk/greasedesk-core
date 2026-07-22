/**
 * File: lib/content-page.ts
 * Shared getServerSideProps for a public content route: resolve the published document by slug + country
 * (exact country → GB fallback) and 404 if nothing is published — a draft is NEVER rendered publicly.
 * Country is GB today; a `/ie` prefix (roadmap) resolves to IE and falls back to GB automatically.
 */
import type { GetServerSideProps } from 'next';

export type PublicDocProps = { title: string; body: string; version: string; effectiveFrom: string | null };

export function documentPage(slug: string): GetServerSideProps<PublicDocProps> {
  return async (ctx) => {
    const { prisma } = await import('@/lib/db');
    const { resolvePublished } = await import('@/lib/content');
    const country = /^\/ie(\/|$)/.test(ctx.resolvedUrl || '') ? 'IE' : 'GB';
    const doc = await resolvePublished(prisma, slug, country);
    if (!doc) return { notFound: true }; // no published version → 404 (never a draft)
    return { props: { title: doc.title, body: doc.body, version: doc.version, effectiveFrom: doc.effective_from ? doc.effective_from.toISOString().slice(0, 10) : null } };
  };
}
