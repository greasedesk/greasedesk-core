/**
 * scripts/seed-nav.mjs
 * Seed the marketing nav (GB) into NavLink so SiteChrome renders footer + main from the Content system.
 * Idempotent: a link with the same (placement, label, country) is left as-is. Adds Privacy + Terms +
 * Cookie policy to the footer.  Run:  node --env-file=.env scripts/seed-nav.mjs
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const LINKS = [
  // main nav (content links; Sign in / Start free trial stay structural in SiteChrome)
  { placement: 'main', label: 'Features', kind: 'route', target: '/#features' },
  { placement: 'main', label: 'Pricing', kind: 'route', target: '/pricing' },
  { placement: 'main', label: 'Contact', kind: 'route', target: '/contact' },
  // footer
  { placement: 'footer', label: 'Pricing', kind: 'route', target: '/pricing' },
  { placement: 'footer', label: 'Contact', kind: 'route', target: '/contact' },
  { placement: 'footer', label: 'Start free trial', kind: 'route', target: '/register' },
  { placement: 'footer', label: 'Sign in', kind: 'route', target: '/admin/login' },
  { placement: 'footer', label: 'Become a reseller', kind: 'route', target: '/reseller' },
  { placement: 'footer', label: 'Privacy policy', kind: 'document', target: 'privacy' },
  { placement: 'footer', label: 'Terms of Service', kind: 'document', target: 'terms' },
  { placement: 'footer', label: 'Cookie policy', kind: 'document', target: 'cookies' },
];

try {
  console.log('Seeding nav (GB)…');
  let order = { main: 0, footer: 0 };
  for (const l of LINKS) {
    order[l.placement] += 10;
    const existing = await p.navLink.findFirst({ where: { placement: l.placement, label: l.label, country_code: 'GB' } });
    if (existing) { console.log(`  skip ${l.placement}:${l.label}`); continue; }
    await p.navLink.create({ data: { ...l, country_code: 'GB', sort_order: order[l.placement], enabled: true } });
    console.log(`  + ${l.placement}:${l.label} (${l.kind} ${l.target})`);
  }
  const n = await p.navLink.count();
  console.log(`Done. NavLink rows: ${n}`);
} finally { await p.$disconnect(); }
