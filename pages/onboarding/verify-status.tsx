/**
 * File: pages/onboarding/verify-status.tsx
 * Where a FAILED email-verification link lands (from /api/auth/verify).
 *
 * ── SiteChrome, NOT OnboardingLayout ────────────────────────────────────────────────────────────
 * Everything else in /onboarding is post-sign-in and wears the wizard shell. This page is not: the
 * visitor arrived by clicking a link in an email and has no session, so a "Sign out" button would
 * be nonsense and a step counter would be a lie. It takes the public chrome, exactly as its sibling
 * check-email does — the pre-auth pages are one family and this was the last of them still dark.
 *
 * ── THE FOUR OUTCOMES ARE NOT ALL FAILURES, AND THEY NO LONGER LOOK ALIKE ───────────────────────
 * The old page painted three of them in reds and yellows of its own mixing. Deliberately mapped:
 *
 *   used      → OK. Nothing is wrong. The account is verified and the link was simply clicked
 *               twice — a very common thing to do with an email. Telling somebody in alarm colours
 *               that they succeeded earlier is the page being rude about its own success.
 *   expired   → WARN. Recoverable, and the remedy is one click, but they cannot proceed today.
 *   invalid   → DANGER. Genuinely broken: a mangled or forged link, and we cannot say which.
 *   (default) → neutral. We are still reading the query string; claiming anything would be a guess.
 */
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import SiteChrome from '@/components/marketing/SiteChrome';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

const TONE: Record<Tone, string> = {
  ok: 'bg-ok-soft border-ok/30',
  warn: 'bg-warn-soft border-warn/30',
  danger: 'bg-danger-soft border-danger/30',
  neutral: 'bg-surface-muted border-line',
};
const HEADING: Record<Tone, string> = {
  ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', neutral: 'text-ink',
};

function Outcome({ status }: { status: string | undefined }) {
  const cases: Record<string, { tone: Tone; title: string; body: string; href: string; cta: string } | undefined> = {
    used: {
      tone: 'ok',
      title: 'Already verified',
      body: 'This link has already been used, which means your account is active. Sign in and carry on.',
      href: '/admin/login', cta: 'Go to sign in',
    },
    expired: {
      tone: 'warn',
      title: 'Link expired',
      body: 'Verification links last 24 hours and this one is older than that. Register again and we’ll send a fresh one.',
      href: '/register', cta: 'Register again',
    },
    invalid: {
      tone: 'danger',
      title: 'Verification failed',
      body: 'We couldn’t make sense of that verification link — it may have been cut short by your email client. If it happens again, register once more.',
      href: '/register', cta: 'Register again',
    },
  };
  // 'server' shares the invalid copy: from the visitor's side the situation and the remedy are the
  // same, and the distinction only matters in our logs.
  const c = cases[status === 'server' ? 'invalid' : (status ?? '')];

  if (!c) {
    return (
      <div className={`border rounded-2xl p-8 text-center ${TONE.neutral}`} data-testid="verify-status">
        <h1 className={`text-xl font-semibold mb-2 ${HEADING.neutral}`}>Verification status</h1>
        <p className="text-sm text-muted">Checking…</p>
      </div>
    );
  }

  return (
    <div className={`border rounded-2xl p-8 text-center ${TONE[c.tone]}`} data-testid="verify-status">
      <h1 className={`text-xl font-semibold mb-2 ${HEADING[c.tone]}`}>{c.title}</h1>
      <p className="text-sm text-ink mb-6">{c.body}</p>
      <Link href={c.href} className="text-sm text-accent font-semibold underline underline-offset-2">
        {c.cta}
      </Link>
    </div>
  );
}

export default function VerifyStatusPage() {
  const router = useRouter();
  const { error } = router.query;
  return (
    <>
      <Head><title>Verification status - GreaseDesk</title></Head>
      <SiteChrome>
        <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
          <Outcome status={typeof error === 'string' ? error : undefined} />
        </div>
      </SiteChrome>
    </>
  );
}
