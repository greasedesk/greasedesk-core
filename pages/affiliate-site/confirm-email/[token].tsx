/**
 * File: pages/affiliate-site/confirm-email/[token].tsx
 * THE LINK FROM THE WELCOME EMAIL. Following it proves the address was reachable.
 *
 * ── IT SPENDS THE TOKEN IN getServerSideProps, AND THAT IS DELIBERATE ──────────────────────────
 * The act is idempotent in the only way that matters — the first stamp wins, and a second click
 * reports success rather than an error — so there is no need for a POST-to-confirm interstitial,
 * and an interstitial is one more thing between a person and a finished job. The usual objection to
 * a GET that writes is prefetchers and scanners firing it: they would mark the address confirmed
 * without a human. Here that is the same claim either way — something reachable at that address
 * opened our email — so it is the right trade rather than a tolerated one.
 *
 * ── IT GRANTS NOTHING ──────────────────────────────────────────────────────────────────────────
 * No session, no code, no sign-in. lib/affiliate-email-verify keeps this purpose apart from
 * 'sign_in' at the lookup precisely so that a verification link cannot be traded for a way in.
 */
import type { GetServerSideProps } from 'next';
import Seo from '@/components/marketing/Seo';
import AffiliateSiteChrome from '@/components/affiliate-site/AffiliateSiteChrome';
import { AFFILIATE_SITE_URL, absoluteAffiliateSiteUrl } from '@/lib/company-info';

const BRAND_ASSET = '/greasedesk-Logo.png';

type Props = { ok: boolean; alreadyDone: boolean; message: string };

export default function ConfirmEmail({ ok, alreadyDone, message }: Props) {
  return (
    <>
      <Seo
        title="Email confirmed — GreaseDesk affiliates"
        description="Confirming an affiliate email address."
        path="/affiliate-site/confirm-email"
        origin={AFFILIATE_SITE_URL}
        ogImage={absoluteAffiliateSiteUrl(BRAND_ASSET)}
      />
      <AffiliateSiteChrome>
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pt-12 sm:pt-16 pb-16">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight"
            data-testid={ok ? 'confirm-ok' : 'confirm-failed'}>
            {ok ? (alreadyDone ? 'Already confirmed' : 'That’s your address confirmed') : 'We couldn’t confirm that'}
          </h1>
          <p className="mt-4 text-sm text-muted">{message}</p>
          <p className="mt-6 text-sm text-muted">
            Your code and link are in the email we sent you. Everything the programme pays is on
            the <a href="/" className="text-accent hover:underline">front page</a> and in
            the <a href="/terms" className="text-accent hover:underline">terms</a>.
          </p>
        </section>
      </AffiliateSiteChrome>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const token = String(ctx.params?.token ?? '');
  const { prisma } = await import('@/lib/db');
  const { spendEmailVerifyLink } = await import('@/lib/affiliate-email-verify');

  const spent = await spendEmailVerifyLink(token, prisma);
  return {
    props: spent.ok
      ? {
        ok: true,
        alreadyDone: spent.alreadyDone,
        message: spent.alreadyDone
          ? 'This address was already confirmed — there is nothing more to do.'
          : 'Thanks. We know we can reach you at this address.',
      }
      : { ok: false, alreadyDone: false, message: spent.message },
  };
};
