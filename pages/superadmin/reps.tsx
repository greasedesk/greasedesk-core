/**
 * File: pages/superadmin/reps.tsx
 * Reps management — OWNER + COUNTRY MANAGER. Placeholder until the rep-management layer lands.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import Placeholder from '@/components/engine-room/Placeholder';

export default function RepsScreen({ role }: { role: OperatorRoleName }) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — reps</title><meta name="robots" content="noindex" /></Head>
      <Placeholder title="Reps" body="Rep records, payout details, garage attribution, and per-rep accrued / pending / clawed-back commission. Coming with the rep-management layer." />
    </EngineRoomLayout>
  );
}
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/reps') }); // country_manager+
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
