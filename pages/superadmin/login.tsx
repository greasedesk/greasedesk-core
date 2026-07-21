/**
 * File: pages/superadmin/login.tsx
 * The /superadmin/login route — a thin wrapper over the shared OperatorLoginForm (also rendered at the
 * bare root er.greasedesk.com/ by the front door). Kept as a direct-access fallback and the target of
 * the reset-flow redirect. Unlinked from any tenant/marketing surface.
 */
import Head from 'next/head';
import OperatorLoginForm from '@/components/engine-room/OperatorLoginForm';

export default function OperatorLogin() {
  return (
    <>
      <Head><title>Engine Room</title><meta name="robots" content="noindex" /></Head>
      <OperatorLoginForm />
    </>
  );
}
