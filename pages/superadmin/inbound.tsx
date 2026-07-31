/**
 * File: pages/superadmin/inbound.tsx
 * Engine Room — INBOUND MESSAGES WE COULD NOT PLACE.
 *
 * An inbound message that resolves to no conversation is still a customer talking to a garage. It is
 * recorded, not dropped, and it surfaces here with the REASON it could not be placed, because a
 * silent bucket is the same as a bin. Honest-null: unresolved means unknown, not discarded.
 */
import React from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import { requireOperatorPage, type OperatorRoleName } from '@/lib/operator-auth';

type Row = { id: string; at: string; from: string; subject: string | null; reason: string | null; tenant: string | null; hasBody: boolean };
type PageProps = { rows: Row[]; role: OperatorRoleName; totalInbound: number };

export default function InboundUnresolved({ rows, role, totalInbound }: PageProps) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Unresolved inbound — Engine Room</title></Head>
      <h1 className="text-xl font-semibold text-white mb-1">Unresolved inbound</h1>
      <p className="text-sm mb-5" style={{ color: '#7C8AA3' }}>
        Messages that arrived but could not be placed on a conversation. They are recorded, never
        discarded — each row says why it could not be resolved. {totalInbound} inbound message{totalInbound === 1 ? '' : 's'} in total.
      </p>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-sm" style={{ borderColor: '#233247', color: '#7C8AA3' }} data-testid="unresolved-empty">
          Nothing unresolved. Every inbound message so far has been placed on a conversation.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: '#233247' }}>
          <table className="w-full text-sm">
            <thead style={{ background: '#0F1B2D', color: '#7C8AA3' }}><tr>
              {['Received', 'From', 'Subject', 'Tenant', 'Body', 'Why it could not be placed'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="unresolved-row" className="border-t" style={{ borderColor: '#233247' }}>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: '#B9C4D6' }}>{r.at.replace('T', ' ').slice(0, 16)}</td>
                  <td className="px-3 py-2 text-white break-all">{r.from}</td>
                  <td className="px-3 py-2" style={{ color: '#B9C4D6' }}>{r.subject ?? '—'}</td>
                  <td className="px-3 py-2" style={{ color: '#B9C4D6' }}>{r.tenant ?? <span style={{ color: '#F87171' }}>unknown</span>}</td>
                  <td className="px-3 py-2" style={{ color: r.hasBody ? '#B9C4D6' : '#F59E0B' }}>{r.hasBody ? 'kept' : 'not retrieved'}</td>
                  <td className="px-3 py-2" style={{ color: '#F59E0B' }}>{r.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx);
  if (!gate.ok) return { notFound: true };
  const raw = await prisma.notificationLog.findMany({
    where: { direction: 'in', thread_id: null },
    orderBy: { created_at: 'desc' },
    take: 200,
    select: { id: true, created_at: true, received_at: true, recipient: true, subject: true, error: true, body: true, group: { select: { ref: true } } },
  });
  return {
    props: {
      role: gate.op.role,
      totalInbound: await prisma.notificationLog.count({ where: { direction: 'in' } }),
      rows: raw.map((r: any) => ({
        id: r.id,
        at: (r.received_at ?? r.created_at).toISOString(),
        from: r.recipient,
        subject: r.subject ?? null,
        reason: r.error ?? null,
        tenant: r.group?.ref ?? null,
        hasBody: !!r.body,
      })),
    },
  };
};
