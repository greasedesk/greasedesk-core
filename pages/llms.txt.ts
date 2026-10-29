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
import { trialDays } from '@/lib/programme-settings';
import { publicPlanChoice } from '@/lib/plan-choice';

function body(trial: number, perMonth: string, perYear: string, perYearEquiv: string): string {
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

${perMonth} per location, per month, or ${perYear} per location per year
(${perYearEquiv} a month, paid yearly). One price — no tiers, no setup fees.
${trial}-day free trial on either plan; a payment card is required to start it. Cancel any time.

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
  // THE HOUR OF CACHING WAS A SECOND COPY OF THE NUMBER, and the comment here said it was not.
  // This page is rendered per request, so the ORIGIN is correct the instant the setting is saved —
  // but it was served `max-age=3600`, so the CDN went on handing out the old trial length for an
  // hour after a save while the Engine Room said the change was live. A cache in front of a value
  // that can change is a copy of it, whatever the comment claims.
  // must-revalidate, matching the marketing pages: the CDN may hold it, and must check first.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  // ── SERVER-RENDERED, SO NOTHING REVALIDATES IT ────────────────────────────────────────────
  // This page has no ISR cache to refresh: it is computed per request, so an Engine Room save is
  // reflected on the next fetch with nothing to invalidate. Said out loud because the pricing and
  // home pages DO need res.revalidate() and the three are easy to lump together — handing
  // res.revalidate('/llms.txt') a path that was never prerendered would throw, and the save would
  // report a failure that is not one.
  //
  // THE FIGURES COME FROM THE SETTINGS (2026-10-29), not from the MONTHLY_PRICE_POUNDS constant
  // this used to read. The facts page is the one surface most likely to be quoted back at us, so
  // it must not be able to disagree with what signup charges.
  const [trial, choice] = await Promise.all([trialDays(), publicPlanChoice(undefined, { referred: false })]);
  res.write(body(
    trial,
    choice.monthly.perLocationLabel,
    choice.annual.renewalPerLocationLabel,
    choice.annual.perMonthEquivLabel,
  ));
  res.end();
  return { props: {} };
};

export default function LlmsTxt() { return null; }
