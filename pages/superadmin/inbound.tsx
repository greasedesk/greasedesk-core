/**
 * File: pages/superadmin/inbound.tsx
 * Engine Room — INBOUND MESSAGES THAT NEED A HUMAN.
 *
 * Two lists, two different failures, deliberately not merged:
 *   • COULD NOT BE PLACED — resolved to no conversation. Recorded, never dropped, with the reason.
 *   • BODY MISSING — placed correctly, but the text was not retrievable. On a 30-day clock, because
 *     Resend discards received mail after that and then it is gone for good.
 * A silent bucket is the same as a bin, so both carry the provider's own words rather than a shrug.
 */
import React from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import { requireOperatorPage, type OperatorRoleName } from '@/lib/operator-auth';

type Row = { id: string; at: string; from: string; subject: string | null; reason: string | null; tenant: string | null; hasBody: boolean };
type BodyRow = { id: string; at: string; from: string; subject: string | null; tenant: string | null; bodyError: string | null; daysLeft: number };
type PageProps = { rows: Row[]; bodyRows: BodyRow[]; role: OperatorRoleName; totalInbound: number };

export default function InboundUnresolved({ rows, bodyRows, role, totalInbound }: PageProps) {
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
      <h2 className="text-lg font-semibold text-white mt-8 mb-1">Bodies not retrieved</h2>
      <p className="text-sm mb-4" style={{ color: '#7C8AA3' }}>
        Placed on a conversation, but the message text could not be fetched. Retried hourly. Resend
        discards received mail after 30 days — the countdown is how long is left to recover it.
      </p>
      {bodyRows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-sm" style={{ borderColor: '#233247', color: '#7C8AA3' }} data-testid="bodies-empty">
          Every inbound message has its text.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: '#233247' }}>
          <table className="w-full text-sm">
            <thead style={{ background: '#0F1B2D', color: '#7C8AA3' }}><tr>
              {['Received', 'From', 'Subject', 'Tenant', 'Days left', 'Why the body is missing'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {bodyRows.map((r) => (
                <tr key={r.id} data-testid="body-missing-row" className="border-t" style={{ borderColor: '#233247' }}>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: '#B9C4D6' }}>{r.at.replace('T', ' ').slice(0, 16)}</td>
                  <td className="px-3 py-2 text-white break-all">{r.from}</td>
                  <td className="px-3 py-2" style={{ color: '#B9C4D6' }}>{r.subject ?? '—'}</td>
                  <td className="px-3 py-2" style={{ color: '#B9C4D6' }}>{r.tenant ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: r.daysLeft <= 0 ? '#F87171' : r.daysLeft < 7 ? '#F59E0B' : '#B9C4D6' }}>
                    {r.daysLeft <= 0 ? 'gone' : `${r.daysLeft.toFixed(1)}d`}
                  </td>
                  {/* Honest-null: no reason recorded is NOT the same as no failure — it means the
                      retry has not run yet against this row. */}
                  <td className="px-3 py-2 break-all" style={{ color: r.bodyError ? '#F59E0B' : '#7C8AA3' }} data-testid="body-error">
                    {r.bodyError ?? 'not yet retried'}
                  </td>
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
  const missing = await prisma.notificationLog.findMany({
    where: { direction: 'in', body: null, body_html: null, thread_id: { not: null } },
    orderBy: { created_at: 'desc' }, take: 200,
    select: { id: true, created_at: true, received_at: true, recipient: true, subject: true, body_error: true, group: { select: { ref: true } } },
  });
  return {
    props: {
      role: gate.op.role,
      bodyRows: missing.map((r: any) => {
        const at = r.received_at ?? r.created_at;
        return { id: r.id, at: at.toISOString(), from: r.recipient, subject: r.subject ?? null, tenant: r.group?.ref ?? null,
                 bodyError: r.body_error ?? null, daysLeft: 30 - (Date.now() - at.getTime()) / 86400000 };
      }),
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
