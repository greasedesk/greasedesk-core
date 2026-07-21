/**
 * File: pages/superadmin/rates.tsx
 * Commission rate table — OWNER ONLY. Placeholder; the effective-dated CommissionRate editor lands
 * with the rate-admin layer (the engine already exists in lib/commission).
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import Placeholder from '@/components/engine-room/Placeholder';

export default function RatesScreen({ role }: { role: OperatorRoleName }) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — rates</title><meta name="robots" content="noindex" /></Head>
      <Placeholder title="Commission rates" body="Effective-dated commission rates by country, currency and tier. Amendments are forward-dated so historical commission never moves. Owner-only. Editor coming with the rate-admin layer." />
    </EngineRoomLayout>
  );
}
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/rates') }); // owner
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
