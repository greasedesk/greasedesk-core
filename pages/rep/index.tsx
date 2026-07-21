/**
 * File: pages/rep/index.tsx
 * Rep portal landing (layer 1 placeholder). Gated by requireRepPage — a tenant or operator session
 * hitting /rep gets a 404 (undiscoverable). The phone-first PWA shell, agreement gate and earnings
 * dashboard land in the rep-portal layer; this proves the rep boundary exists and holds.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireRepPage } from '@/lib/rep-auth';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireRepPage(ctx);
  if (!gate.ok) return { notFound: true };
  return { props: { repId: gate.rep.repId } };
};

export default function RepHome({ repId }: { repId: string }) {
  return (
    <>
      <Head><title>Rep portal</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen bg-emerald-950 text-white p-6">
        <h1 className="text-lg font-semibold">Rep portal</h1>
        <p className="text-sm text-emerald-200 mt-1">Signed in. Earnings dashboard arrives with the rep-portal layer.</p>
        <p className="text-xs text-emerald-400 mt-4">rep:{repId.slice(0, 8)}</p>
      </div>
    </>
  );
}
