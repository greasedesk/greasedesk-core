/**
 * File: pages/superadmin/operators.tsx
 * Operators management — OWNER ONLY (the nav link is hidden for others AND this page independently
 * 404s a non-owner; hidden link is not a guard). Placeholder until operator CRUD lands.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import Placeholder from '@/components/engine-room/Placeholder';

export default function OperatorsScreen({ role }: { role: OperatorRoleName }) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — operators</title><meta name="robots" content="noindex" /></Head>
      <Placeholder title="Operators" body="Create and manage platform operators — assign role and region, suspend access. Owner-only. Coming with the operator-management layer." />
    </EngineRoomLayout>
  );
}
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/operators') }); // owner
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
