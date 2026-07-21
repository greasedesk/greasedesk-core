/**
 * File: pages/superadmin/settings.tsx
 * The operator's OWN account screen — all roles. Placeholder; credential management (change email /
 * password for the operator's own Operator record) lands here later.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import Placeholder from '@/components/engine-room/Placeholder';

export default function SettingsScreen({ role, email }: { role: OperatorRoleName; email: string }) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — settings</title><meta name="robots" content="noindex" /></Head>
      <Placeholder title="Your account" body={`Signed in as ${email} (${role.replace('_',' ')}). Credential management — change your email or password — lands here next.`} />
    </EngineRoomLayout>
  );
}
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx); // any operator
  if (!gate.ok) return { notFound: true };
  const { prisma } = await import('@/lib/db');
  const op = await prisma.operator.findUnique({ where: { id: gate.op.userId }, select: { email: true } });
  return { props: { role: gate.op.role, email: op?.email ?? '—' } };
};
