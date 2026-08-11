/**
 * File: pages/llms.txt.ts
 * /llms.txt — what GreaseDesk is, in plain text, for language models and anyone reading the source.
 *
 * ── A ROUTE, NOT A STATIC FILE ──────────────────────────────────────────────────────────────────
 * The price and the trial length are the two facts most likely to be quoted back at us, and both
 * already live in constants that Stripe is charged against. A file in /public would be a third copy
 * of each, correct on the day it was written and wrong the first time either changes — the same
 * drift the £35 price incident came from. Reading the constants means this page cannot disagree
 * with the checkout.
 *
 * ── ONLY WHAT IS SHIPPED ────────────────────────────────────────────────────────────────────────
 * Every capability below is a working surface. Part-built work is left out, because a model will
 * repeat this back to a garage owner as fact and there is no way to footnote a summary.
 */
import type { GetServerSideProps } from 'next';
import { COMPANY } from '@/lib/company-info';
import { MONTHLY_PRICE_POUNDS } from '@/lib/billing-pricing';
import { TRIAL_PERIOD_DAYS } from '@/lib/stripe';

function body(): string {
  const u = (p: string) => `${COMPANY.siteUrl}${p}`;
  return `# ${COMPANY.tradingName}

> Garage management software for independent vehicle repair workshops in the UK.
> Job cards, diary, quotes and VAT invoicing, with a live profit-and-loss view
> alongside them — so a garage can see what a month actually made, not just how
> busy it was.

## What it is

${COMPANY.tradingName} is a web application, with a companion mobile app for mechanics,
used by independent garages to run day-to-day work and to see the money behind it.
Operated by ${COMPANY.legalName}, a company registered in England and Wales,
company number ${COMPANY.companyNumber}.

## Who it is for

Independent vehicle repair garages and small workshop groups in the United Kingdom,
typically one to five locations. Not currently available outside the UK.

## Key capabilities

- Job cards with a gated workflow, from booking through to invoice
- Diary and bookings with capacity and utilisation planning
- Quotes with version history and customer acceptance
- VAT invoicing on a gapless numbered series; invoices freeze at issue
- Payments, account customers on credit terms, debtors and overdue tracking
- Live profit-and-loss, labour utilisation and capacity dashboards
- Parts and labour catalogue with cost and margin
- Customer messaging by email and SMS
- Multi-location support and staff records

## Pricing

£${MONTHLY_PRICE_POUNDS} per location, per month. One price — no tiers, no setup fees.
${TRIAL_PERIOD_DAYS}-day free trial; a payment card is required to start it. Cancel any time.

## Links

- Home: ${u('/')}
- Pricing: ${u('/pricing')}
- Contact: ${u('/contact')}
- Become a reseller: ${u('/reseller')}
- Terms of Service: ${u('/terms')}
- Privacy policy: ${u('/privacy')}
- Cookie policy: ${u('/cookies')}
`;
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  // charset=utf-8 matters: the copy carries £ and an em dash, and a client guessing latin-1 would
  // render both as mojibake.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.write(body());
  res.end();
  return { props: {} };
};

export default function LlmsTxt() { return null; }
