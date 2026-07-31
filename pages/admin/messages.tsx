/**
 * File: pages/admin/messages.tsx
 * The Messages screen — every customer conversation for the tenant, newest activity first, and the
 * selected thread's history. READ-ONLY in this slice: no compose, no reply, no mark-as-read, because
 * the product cannot receive a message yet and a reply box would promise something that does not exist.
 *
 * Threads are keyed on (customer, vehicle) — see lib/message-threads for why the customer is part of
 * the key even though ownership transfer has never been performed.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';
import ConversationView, { type ConversationMessage } from '@/components/messages/ConversationView';
import { getVisibility } from '@/lib/site-visibility';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { listThreadMessages, openThreadCount } from '@/lib/message-threads';

type ThreadRow = {
  id: string; customerName: string; registration: string; lastMessageAt: string | null;
  messageCount: number; state: string; unread: number;
};
type PageProps = { threads: ThreadRow[]; messages: Record<string, ConversationMessage[]>; navCount: number; locale: string };

const fmtDay = (iso: string | null, locale: string) =>
  iso ? new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export default function MessagesPage({ threads, messages, navCount, locale }: PageProps) {
  const [sel, setSel] = useState<string | null>(threads[0]?.id ?? null);
  const current = sel ? threads.find((t) => t.id === sel) ?? null : null;

  return (
    <AdminLayout messagesCount={navCount}>
      <Head><title>Messages — GreaseDesk</title></Head>
      <h1 className="text-xl font-semibold text-ink mb-1">Messages</h1>
      <p className="text-sm text-muted mb-5">
        Every message the garage has sent a customer, grouped by customer and vehicle. Read-only for
        now — replies aren&rsquo;t received yet, so nothing here can be answered from this screen.
      </p>

      {threads.length === 0 ? (
        <p className="text-sm text-muted border border-dashed border-line rounded-xl p-6" data-testid="threads-empty">
          No customer conversations yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,22rem)_1fr] gap-5">
          <ol className="space-y-1" data-testid="thread-list">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setSel(t.id)}
                  data-testid="thread-row"
                  className={`w-full text-left border rounded-xl p-3 ${sel === t.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-muted'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink text-sm">{t.registration}</span>
                    <span className="text-xs text-muted truncate">{t.customerName}</span>
                    <span className="ml-auto text-xs text-muted tabular-nums">{fmtDay(t.lastMessageAt, locale)}</span>
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {t.messageCount === 1 ? '1 message' : `${t.messageCount} messages`} · {t.state}
                  </div>
                </button>
              </li>
            ))}
          </ol>

          <div className="bg-surface border border-line rounded-xl p-5">
            {current ? (
              <>
                <div className="mb-3">
                  <h2 className="text-base font-semibold text-ink">{current.registration} · {current.customerName}</h2>
                  <p className="text-xs text-muted">
                    Unread {current.unread} — the product has no inbound message path yet, so this stays 0 until replies can be received.
                  </p>
                </div>
                <ConversationView messages={messages[current.id] ?? []} locale={locale} heading={null} dense />
              </>
            ) : <p className="text-sm text-muted">Pick a conversation.</p>}
          </div>
        </div>
      )}
      <p className="text-xs text-muted mt-6">
        Messages about a job card also appear on that card&rsquo;s Customer Details tab.{' '}
        <Link href="/admin/jobcards" className="text-accent hover:underline">Job cards</Link>
      </p>
    </AdminLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  await getVisibility(user.id as string); // tenant scope is group_id below; this asserts the session resolves
  const groupId = user.group_id as string;

  const rows = await prisma.messageThread.findMany({
    where: { group_id: groupId },
    orderBy: [{ last_message_at: 'desc' }],
    include: { customer: { select: { name: true } }, vehicle: { select: { registration: true } }, _count: { select: { messages: true } } },
  });
  const threads: ThreadRow[] = rows.map((t: any) => ({
    id: t.id,
    customerName: t.customer?.name ?? '—',
    registration: t.vehicle?.registration ?? '—',
    lastMessageAt: t.last_message_at ? t.last_message_at.toISOString() : null,
    messageCount: t._count.messages,
    state: t.state,
    unread: t.unread_count,
  }));
  const messages: Record<string, ConversationMessage[]> = {};
  for (const t of rows) messages[t.id] = await listThreadMessages(prisma, t.id);

  const site = await prisma.site.findFirst({ where: { group_id: groupId }, select: { locale: true } });
  return { props: { threads, messages, navCount: await openThreadCount(prisma, groupId), locale: site?.locale ?? 'en-GB' } };
};
