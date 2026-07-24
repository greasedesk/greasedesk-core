/**
 * File: pages/c/[token].tsx
 * The CUSTOMER end of a magic link. No session, no login — the URL is the credential (see the
 * security model in lib/magic-link). Resolution happens SERVER-SIDE in getServerSideProps: the raw
 * token never reaches client JS as a usable secret beyond the URL itself, and an invalid link never
 * renders card data.
 *
 * An expired/revoked link EXPLAINS ITSELF — "this link has expired, ask the garage for a new one" —
 * rather than 404ing. A 404 reads as "GreaseDesk is broken"; the truth is "your link aged out".
 */
import React from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { resolveMagicLink, MAGIC_LINK_DAYS } from '@/lib/magic-link';
import { clientIp } from '@/lib/auth-rate-limit';

type Denied = 'expired' | 'revoked' | 'not_found' | 'rate_limited' | 'wrong_purpose';

type Props =
  | { state: 'ok'; garageName: string; registration: string | null; purpose: string; expiresAt: string }
  | { state: 'denied'; reason: Denied };

const shellCls = 'min-h-screen bg-surface-muted flex items-center justify-center p-4';
const cardCls = 'bg-surface border border-line rounded-2xl shadow-sm max-w-md w-full p-6 sm:p-8';

const DENIED_COPY: Record<Denied, { title: string; body: string }> = {
  expired: {
    title: 'This link has expired',
    body: `Links stay valid for ${MAGIC_LINK_DAYS} days. Please contact the garage and ask them to send you a fresh one — your job and its details are safe, only the link has aged out.`,
  },
  revoked: {
    title: 'This link is no longer active',
    body: 'The garage has withdrawn this link. Please contact them directly if you still need to see this job.',
  },
  not_found: {
    title: "We couldn't find that link",
    body: 'The address may have been copied incompletely — links are long, and email clients sometimes break them across lines. Try opening it again from the original message, or ask the garage to resend it.',
  },
  wrong_purpose: {
    title: "This link doesn't open this page",
    body: 'Please use the link exactly as the garage sent it, or ask them to resend it.',
  },
  rate_limited: {
    title: 'Too many attempts',
    body: 'Too many links have been opened from this connection in the last hour. Please wait a little while and try again.',
  },
};

export default function CustomerMagicLinkPage(props: Props) {
  if (props.state === 'denied') {
    const copy = DENIED_COPY[props.reason];
    return (
      <>
        <Head><title>{copy.title} — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
        <div className={shellCls}>
          <div className={cardCls}>
            <h1 className="text-xl font-bold text-ink mb-2">{copy.title}</h1>
            <p className="text-sm text-muted leading-relaxed">{copy.body}</p>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <Head><title>Your job at {props.garageName} — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <div className={shellCls}>
        <div className={cardCls}>
          <p className="text-xs uppercase tracking-wide text-muted mb-1">{props.garageName}</p>
          <h1 className="text-2xl font-bold text-ink mb-3">
            {props.registration ? `Your vehicle ${props.registration}` : 'Your job'}
          </h1>
          <p className="text-sm text-muted leading-relaxed">
            This link is valid until {new Date(props.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
          </p>
          {/* The quote/portal surface itself lands in the next slice — this slice proves the
              credential, its expiry and its explanation, which everything above will sit on. */}
          <p className="mt-4 text-sm text-muted">Your garage will be in touch with the details.</p>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const token = String(ctx.params?.token ?? '');
  const res = await resolveMagicLink(token, { ip: clientIp(ctx.req.headers as any) });
  if (!res.ok) return { props: { state: 'denied', reason: res.reason } };

  const card = await prisma.jobCard.findFirst({
    where: { id: res.link.jobCardId, group_id: res.link.groupId },
    select: { vehicle: { select: { registration: true } }, group: { select: { group_name: true, trading_name: true } } },
  });

  return {
    props: {
      state: 'ok',
      garageName: card?.group?.trading_name || card?.group?.group_name || 'Your garage',
      registration: card?.vehicle?.registration ?? null,
      purpose: res.link.purpose,
      expiresAt: res.link.expiresAt.toISOString(),
    },
  };
};
