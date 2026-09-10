/**
 * File: pages/rep/prospects/index.tsx
 * THE GARAGES THIS REP HAS VISITED — and a big button to record the next one.
 *
 * No email address is shown here, only whether one is held: a list on a phone in a forecourt has no
 * need of anybody's personal data, and the follow-up state in words tells the rep what they need.
 */
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { STATUS_LABEL, STOP_LABEL, type ProspectStatus, type StopReason } from '@/lib/prospects';

type Row = { id: string; garageName: string; postcode: string | null; status: string; lastVisit: string | null; followUp: string };

export default function MyVisits({ rows }: { rows: Row[] }) {
  return (
    <>
      <Head><title>My visits</title><meta name="robots" content="noindex" /></Head>
      <div className="min-h-screen bg-emerald-950 text-white p-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold" data-testid="prospect-list">Garages visited</h1>
          <Link href="/rep" className="text-sm text-emerald-300 underline">Home</Link>
        </div>
        <Link href="/rep/prospects/new" data-testid="prospect-new"
          className="mt-5 flex items-center justify-center min-h-[60px] rounded-xl bg-emerald-500 text-emerald-950 font-semibold text-lg">
          Record a visit
        </Link>
        {rows.length === 0 ? (
          <p className="mt-8 text-sm text-emerald-200" data-testid="prospect-none">No visits recorded yet. The first one takes about thirty seconds.</p>
        ) : (
          <ul className="mt-6 space-y-2">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl bg-emerald-900 p-4">
                <div className="flex justify-between gap-3">
                  <div className="font-medium">{r.garageName}</div>
                  <div className="text-xs text-emerald-300 shrink-0">{STATUS_LABEL[r.status as ProspectStatus] ?? r.status}</div>
                </div>
                <div className="text-xs text-emerald-300 mt-1">{[r.postcode, r.lastVisit ? `last visit ${r.lastVisit}` : null].filter(Boolean).join(' · ')}</div>
                <div className="text-xs text-emerald-400 mt-1">{r.followUp}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { requireRepPage } = await import('@/lib/rep-auth');
  const { prisma } = await import('@/lib/db');
  const gate = await requireRepPage(ctx);
  if (!gate.ok) return gate.result;
  const repId = gate.rep.repId;
  const ps = await prisma.prospect.findMany({
    where: { OR: [{ created_by_rep_id: repId }, { visits: { some: { rep_id: repId } } }] },
    select: {
      id: true, garage_name: true, postcode: true, status: true, email: true, personal_stripped_at: true,
      visits: { orderBy: { visited_on: 'desc' }, take: 1, select: { visited_on: true } },
      sequence: { select: { state: true, stopped_reason: true } },
    },
    orderBy: { updated_at: 'desc' },
    take: 50,
  });
  const rows: Row[] = ps.map((p) => ({
    id: p.id, garageName: p.garage_name, postcode: p.postcode, status: p.status,
    lastVisit: p.visits[0]?.visited_on.toISOString().slice(0, 10) ?? null,
    // THE FOLLOW-UP IN WORDS — and a stopped one says why, never just that it stopped.
    followUp: p.sequence
      ? (p.sequence.state === 'active' ? 'Follow-up emails running' : STOP_LABEL[p.sequence.stopped_reason as StopReason] ?? 'Follow-up stopped')
      : p.personal_stripped_at ? 'No follow-up — contact details removed'
      : p.email ? 'No follow-up — they did not agree to emails' : 'No follow-up — no email given',
  }));
  return { props: { rows } };
};
