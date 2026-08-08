/**
 * File: pages/onboarding/phone.tsx
 * The signup phone step. DELIBERATELY OUTSIDE the onboarding gate: it is not in ONBOARDING_ORDER and
 * onboardingGateRedirect never routes here, so it cannot trap anybody — the four gated steps
 * (country → site → rates → tax → checkout) are unchanged and this sits after them.
 *
 * WHY HERE AND NOT AT REGISTRATION. register-garage does not sign anyone in — the user goes to
 * check-email with no session — so a phone step on that page would have no authenticated identity to
 * attach a number to. The billing step is the first authenticated moment at the end of signup, so the
 * step lands here and "I'll do this later" goes straight on to the dashboard.
 */
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import PhoneVerifyPanel from '@/components/settings/PhoneVerifyPanel';

export default function OnboardingPhone() {
  const router = useRouter();
  const go = () => router.replace('/admin/dashboard');
  return (
    <>
      <Head><title>Add your mobile number - GreaseDesk</title></Head>
      <div className="min-h-screen bg-surface-muted py-10 px-4">
        <div className="max-w-xl mx-auto bg-surface border border-line rounded-2xl p-6">
          <p className="text-xs text-muted mb-3">Last thing — and you can skip it.</p>
          <PhoneVerifyPanel onSkip={go} onDone={go} />
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id || !u?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  return { props: {} };
};
