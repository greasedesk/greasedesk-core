/**
 * scripts/seed-legal-docs.mjs
 * Seed the existing legal documents into the Content system as published versions. Idempotent: skips a
 * (slug, country, version) that already exists.
 *   - cookies : version '2026-07-21' (preserves the stamp the consent system already records), effective
 *               2026-07-21. Body inline (authored as the factual cookie disclosure + draft banner).
 *   - privacy : slug 'privacy', version 'v1', effective today — body read from privacy-policy-v3.md IF
 *               present (repo root or ./legal-drafts/); its [YOU SUPPLY]/[CONFIRM]/[OUTSTANDING] gaps and
 *               draft banner are preserved verbatim. Skipped (with a notice) if the file is absent.
 *   - terms   : slug 'terms', version 'v1', effective today — body from terms-of-service-DRAFT.md, same.
 *   Run:  node --env-file=.env scripts/seed-legal-docs.mjs
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const TODAY = process.env.SEED_EFFECTIVE || '2026-07-22'; // "today" (Date.now avoided; pass to override)
const D = (s) => new Date(s + 'T00:00:00.000Z');

const COOKIES_BODY = `> **Draft — legal wording pending review.** The cookie table below is factual and current; the surrounding legal sections are placeholders for GreaseDesk to complete.

## What we use

We run strictly-necessary cookies to keep the site working, one optional functional cookie (referral attribution), and — today — **no analytics or advertising cookies**. You choose the optional categories in the banner, and can change your mind any time via "Cookie settings".

| Cookie | Purpose | Category | Party | Lifespan |
|---|---|---|---|---|
| \`__Secure-next-auth.session-token\` | Keeps you signed in (session) | Strictly necessary | First party | 90 days (rolling) |
| \`__Host-next-auth.csrf-token\` | Protects the sign-in form (CSRF) | Strictly necessary | First party | Session |
| \`__Secure-next-auth.callback-url\` | Returns you to the right page after sign-in | Strictly necessary | First party | Session |
| \`gd_consent\` | Remembers your cookie choice | Strictly necessary | First party | 180 days |
| \`gd_ref\` | Credits a reseller who referred you (referral attribution) | Functional | First party | 90 days |
| Cloudflare Turnstile | Anti-spam check on the contact & reseller forms only | Strictly necessary (security) | Third party (Cloudflare) | Short-lived |
| Stripe (checkout.stripe.com) | Payment/fraud on Stripe's hosted checkout — only if you subscribe | Strictly necessary (payment) | Third party (Stripe) | Stripe-set |

_[LEGAL TODO: data controller identity, lawful basis for functional cookies (consent), how to withdraw consent, data-subject rights, third-party processor detail, retention. Legal review pending.]_`;

function findDraft(...names) {
  for (const n of names) {
    for (const dir of [process.cwd(), path.join(process.cwd(), 'legal-drafts'), path.join(process.cwd(), '..')]) {
      const p = path.join(dir, n);
      if (existsSync(p)) return { path: p, body: readFileSync(p, 'utf8') };
    }
  }
  return null;
}

async function seed({ slug, title, version, effective, body }) {
  const existing = await prisma.document.findUnique({ where: { slug_country_code_version: { slug, country_code: 'GB', version } } });
  if (existing) { console.log(`  skip ${slug} v${version} (already seeded)`); return; }
  await prisma.document.create({ data: { slug, title, type: 'legal', country_code: 'GB', body, version, status: 'published', effective_from: D(effective), published_at: new Date(), created_by: null } });
  console.log(`  seeded ${slug} v${version} (effective ${effective}, ${body.length} chars)`);
}

try {
  console.log('Seeding legal documents…');
  await seed({ slug: 'cookies', title: 'Cookie policy', version: '2026-07-21', effective: '2026-07-21', body: COOKIES_BODY });

  const privacy = findDraft('privacy.md', 'privacy-policy-v3.md', 'privacy-policy.md');
  if (privacy) await seed({ slug: 'privacy', title: 'Privacy policy', version: 'v1', effective: TODAY, body: privacy.body });
  else console.log('  SKIP privacy — privacy.md not found (drop it in ./legal-drafts/ and re-run)');

  const terms = findDraft('terms.md', 'terms-of-service-DRAFT.md', 'terms-of-service.md');
  if (terms) await seed({ slug: 'terms', title: 'Terms of Service', version: 'v1', effective: TODAY, body: terms.body });
  else console.log('  SKIP terms — terms.md not found (drop it in ./legal-drafts/ and re-run)');

  const total = await prisma.document.count({ where: { status: 'published' } });
  console.log(`Done. Published documents now: ${total}`);
} finally { await prisma.$disconnect(); }
