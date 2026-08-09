/**
 * File: pages/admin/settings/rep.tsx
 * Settings → Account → My Rep. Who introduced this garage to GreaseDesk, and how to reach them.
 *
 * ── NO ROLE GATE (ruling 2026-08-09) ────────────────────────────────────────────────────────────
 * Every role sees it. Knowing who to call is not privileged information, and the person who
 * actually picks up the phone in a workshop is rarely the account holder. Nothing here is
 * commercially sensitive — the rep's commission share, payout details and referral code are all
 * excluded at the resolver, so there is nothing on this page a mechanic should not see.
 *
 * ── THE EMPTY STATE IS THE COMMON CASE, AND READS LIKE IT ───────────────────────────────────────
 * Today it is the ONLY case: there are no reps and no attributions. Most garages sign up directly
 * and always will, so "no rep" must not read as something missing or misconfigured — it is an
 * ordinary fact with a next step attached, not a gap with an apology.
 *
 * ── A REP IS NOT A SUPPORT DESK ─────────────────────────────────────────────────────────────────
 * The support line stays even when a rep IS shown. A rep is a salesperson; routing a garage with a
 * broken diary to the person who signed them up costs them a day. Naming the faster route is worth
 * more than the tidier card.
 */
import React from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { getVisibility } from '@/lib/site-visibility';
import { tenantRep, type TenantRep } from '@/lib/tenant-rep';
import { COMPANY } from '@/lib/company-info';

type PageProps = { isAdmin: boolean; isManager: boolean; rep: TenantRep | null };

/** The one place the GreaseDesk route is named, so both branches say the same thing. */
function SupportLine() {
  return (
    <p className="text-sm text-muted mt-4 pt-4 border-t border-line" data-testid="rep-support">
      For technical help — anything not working as it should — contact the GreaseDesk team on{' '}
      <a className="text-accent font-semibold" href={`tel:${COMPANY.phoneE164}`}>{COMPANY.phone}</a>{' '}
      or through the <a className="text-accent underline underline-offset-2" href="/contact">contact form</a>.
      That reaches us directly and is usually faster.
    </p>
  );
}

export default function MyRep({ isAdmin, isManager, rep }: PageProps) {
  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
      <Head><title>My rep - GreaseDesk</title></Head>
      <div className="bg-surface border border-line rounded-xl p-6 max-w-md">
        <h2 className="text-lg font-semibold text-ink mb-1">Your GreaseDesk rep</h2>

        {rep ? (
          <div data-testid="rep-card">
            <p className="text-base font-semibold text-ink mt-3">{rep.name}</p>
            <p className="text-sm mt-0.5">
              <a className="text-accent" href={`mailto:${rep.email}`}>{rep.email}</a>
            </p>
            <p className="text-sm text-muted mt-3">
              {rep.name.split(' ')[0]} introduced you to GreaseDesk and is your first point of contact
              for questions about your account or subscription.
            </p>
          </div>
        ) : (
          <div data-testid="rep-empty">
            <p className="text-sm text-ink mt-2">You don’t have a rep — you signed up directly with GreaseDesk.</p>
            <p className="text-sm text-muted mt-1">
              That’s perfectly normal, and nothing is missing from your account.
            </p>
          </div>
        )}

        <SupportLine />
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id || !u?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  const vis = await getVisibility(u.id as string);
  return {
    props: {
      isAdmin: vis.isAdmin,
      isManager: vis.role === 'SITE_MANAGER',
      rep: await tenantRep(u.group_id as string),
    },
  };
};
