/**
 * File: pages/superadmin/affiliates.tsx
 * AFFILIATES — OWNER ONLY (gSSP enforces minRole 'owner'; the nav link is hidden for everyone else
 * AND this page 404s them).
 *
 * ── TODAY IT IS THE WAITING LIST, AND THAT IS THE WHOLE SCREEN ─────────────────────────────────
 * The public site shows the programme whether or not joining is open; when it is shut the join
 * button is replaced by "leave your email and we'll tell you". Those addresses had nowhere to be
 * read, which is the only reason this page exists now. The affiliates list itself — name, code,
 * confirmed mobile, referrals, earnings, suspend — is its own slice and lands here beside it.
 *
 * REGISTERED IN ER_NAV, and that is not decoration: erMinRole falls back to 'support' for an
 * unregistered href, so a page that forgot its line would be open to the lowest operator role.
 *
 * ── READ IN getServerSideProps, WITH NO API ────────────────────────────────────────────────────
 * There is nothing to mutate here yet. An endpoint plus a fetch plus a loading state, to render a
 * list that cannot change while you look at it, would be three moving parts earning nothing. When
 * this screen gains an action — telling the list the programme has opened — that action gets an API
 * with its own guard, and the read can stay where it is.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Entry = { id: string; email: string; audience: string | null; created_at: string };
type Props = { role: OperatorRoleName; entries: Entry[]; joiningOpen: boolean };

const AUDIENCE_LABEL: Record<string, string> = { trade: 'Motor trade', creator: 'Content' };

/** A date an operator reads, not an ISO string. Fixed locale: this screen has one audience. */
const when = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function AffiliatesScreen({ role, entries, joiningOpen }: Props) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — affiliates</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-4xl">
        <h1 className="text-xl font-semibold text-ink">Affiliates</h1>

        {/* THE SWITCH'S STATE, SAID OUT LOUD. The list below only grows while joining is shut, so a
            screen that showed the list without saying which way the switch is set would invite
            "why has nobody joined?" about a programme whose door is open. */}
        <p className="mt-2 text-sm text-muted" data-testid="joining-state">
          {joiningOpen
            ? 'New affiliates can join: the public site shows the signup button.'
            : 'Joining is closed: the public site shows the waiting-list form instead of the signup button.'}
          {' '}Change it under <span className="text-ink">Billing</span>.
        </p>

        <h2 className="mt-8 text-base font-semibold text-ink">
          Waiting list <span className="text-muted font-normal" data-testid="waitlist-count">({entries.length})</span>
        </h2>
        <p className="mt-1 text-xs text-muted">
          People who asked to be told when the programme opens. Not affiliates: nobody here has a code
          or has accepted any terms.
        </p>

        {entries.length === 0 ? (
          // NOT "no results". An empty list here means nobody has asked yet, which is a fact about
          // the programme rather than a failed search — and it reads differently to an operator.
          <p className="mt-4 text-sm text-muted" data-testid="waitlist-empty">Nobody has asked yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto border border-line rounded-lg">
            <table className="w-full text-sm" data-testid="waitlist-table">
              <thead className="bg-surface-muted text-muted">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Email</th>
                  <th className="text-left font-medium px-3 py-2">Which are they</th>
                  <th className="text-left font-medium px-3 py-2">Asked</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-line" data-testid="waitlist-row">
                    <td className="px-3 py-2 text-ink">{e.email}</td>
                    {/* THREE STATES ON THE SCREEN TOO: they said trade, they said creator, or they
                        did not say. An em dash rather than a blank cell, so "did not say" cannot be
                        mistaken for a rendering fault. */}
                    <td className="px-3 py-2 text-muted">{e.audience ? AUDIENCE_LABEL[e.audience] ?? e.audience : '—'}</td>
                    <td className="px-3 py-2 text-muted">{when(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/affiliates') }); // owner
  if (!gate.ok) return { notFound: true };

  const { prisma } = await import('@/lib/db');
  const { currentTerms } = await import('@/lib/affiliate');

  // OLDEST FIRST: it is a queue, and the order people asked in is the order they are told in.
  const rows = await prisma.affiliateWaitlist.findMany({
    orderBy: { created_at: 'asc' },
    select: { id: true, email: true, audience: true, created_at: true },
  });
  const terms = await currentTerms(prisma);

  return {
    props: {
      role: gate.op.role,
      joiningOpen: terms.joiningOpen,
      entries: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    },
  };
};
