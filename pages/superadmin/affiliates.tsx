/**
 * File: pages/superadmin/affiliates.tsx
 * AFFILIATES — OWNER ONLY (gSSP enforces minRole 'owner'; the nav link is hidden for everyone else
 * AND this page 404s them).
 *
 * Two lists, in the order an operator cares about them: the affiliates, and then the people waiting
 * for the programme to open. The waiting list came first (slice C) because those addresses had
 * nowhere to be read; the affiliates themselves are the screen's real subject.
 *
 * REGISTERED IN ER_NAV, and that is not decoration: erMinRole falls back to 'support' for an
 * unregistered href, so a page that forgot its line would be open to the lowest operator role.
 *
 * ── WHAT SUSPENSION DOES IS SAID ON THE SCREEN, NOT LEARNED FROM A SURPRISE ────────────────────
 * The button stops somebody's income, so the three consequences and the one non-consequence are
 * written beside it: no new referrals, no new garage gets the offer, nothing earns from that
 * moment — and a garage already referred keeps its frozen price, with nothing already accrued
 * reversed. An operator should not have to read lib/affiliate to know what they are about to do.
 *
 * ── READ IN getServerSideProps, WRITTEN THROUGH THE API ────────────────────────────────────────
 * The first read is server-side, so there is no loading state for a list that is there when the
 * page is. The suspend button posts, and the response carries the whole list back — the screen
 * never re-derives a number the server already computed.
 */
import { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Garage = { groupId: string; ref: string | null; name: string; status: string; referredAt: string; everPaid: boolean };
type Row = {
  id: string; name: string; email: string; refCode: string; joinedAt: string;
  mobile: string | null; mobileVerifiedAt: string | null; emailVerifiedAt: string | null;
  termsAcceptedAt: string | null; suspendedAt: string | null; socialHandle: string | null;
  garages: Garage[]; earnedPennies: number; payablePennies: number; heldPennies: number;
  bankMasked: string | null;
};
type Entry = { id: string; email: string; audience: string | null; created_at: string };
type ReferredPerson = { name: string | null; email: string; garage: string };
type PayeeReq = {
  id: string; affiliateId: string; affiliateName: string; refCode: string; payeeKind: string;
  accountName: string; masked: string; nomineeEmail: string | null; requestedAt: string;
  referredPeople: ReferredPerson[]; currentMasked: string | null;
};
type Props = {
  role: OperatorRoleName; affiliates: Row[]; entries: Entry[]; joiningOpen: boolean; holdDays: number;
  payeeRequests: PayeeReq[];
};

const AUDIENCE_LABEL: Record<string, string> = { trade: 'Motor trade', creator: 'Content' };
const money = (p: number) => `£${(p / 100).toFixed(2)}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

/** Verified or not, as a WORD rather than a tick: a tick and a blank cell read the same at a glance. */
const Verified = ({ at, what }: { at: string | null; what: string }) => (
  // NAMED, so a clause can ask about THIS verification rather than regex the whole row for a
  // "SMS: yes" shape. One label, two subjects is how a gate ends up asserting the wrong one.
  <span data-testid={`verified-${what.toLowerCase()}`}
    className={at ? 'text-ok' : 'text-muted'} title={at ? `${what} confirmed ${when(at)}` : `${what} not confirmed`}>
    {what}: {at ? 'yes' : 'no'}
  </span>
);

export default function AffiliatesScreen({ role, affiliates, entries, joiningOpen, holdDays, payeeRequests }: Props) {
  const [rows, setRows] = useState<Row[]>(affiliates);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reqs, setReqs] = useState<PayeeReq[]>(payeeRequests);
  /**
   * THE REVEALED DIGITS LIVE IN COMPONENT STATE AND NOWHERE ELSE — not in the page's props, not in
   * localStorage, not in a URL. They arrive only in the response to a deliberate POST that has
   * already written an audit row, and they are gone on the next navigation.
   */
  const [revealed, setRevealed] = useState<Record<string, { accountName: string | null; sortCode: string; accountNumber: string }>>({});

  async function payeeAction(body: Record<string, unknown>, key: string): Promise<any> {
    setBusy(key); setMsg(null);
    try {
      const r = await fetch('/api/superadmin/payee-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d?.message || 'That did not work.'); return null; }
      if (Array.isArray(d?.requests)) setReqs(d.requests);
      return d;
    } catch { setMsg('We could not reach the server.'); return null; }
    finally { setBusy(null); }
  }

  async function reveal(affiliateId: string) {
    // SAID BEFORE IT HAPPENS, because the look itself is the recorded act and cannot be undone.
    if (typeof window !== 'undefined'
      && !window.confirm('Show these bank details? The look is recorded against your operator account.')) return;
    const d = await payeeAction({ action: 'reveal', affiliateId }, `reveal:${affiliateId}`);
    if (d?.value) setRevealed((prev) => ({ ...prev, [affiliateId]: d.value }));
  }

  async function toggle(row: Row) {
    const suspend = !row.suspendedAt;
    // CONFIRMED, because it stops an income and this sentence is the only warning there is.
    const ask = suspend
      ? `Suspend ${row.name}? From now on: no new referrals, no new garage gets the offer on their code, and nothing earns. Garages they already referred keep their price, and nothing already earned is reversed.`
      : `Unsuspend ${row.name}? They can take new referrals again and earn from now on. The months they were suspended for stay unearned.`;
    if (typeof window !== 'undefined' && !window.confirm(ask)) return;
    setBusy(row.id); setMsg(null);
    try {
      const r = await fetch('/api/superadmin/affiliates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affiliateId: row.id, suspended: suspend }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.ok) { setRows(d.affiliates); setMsg(d.changed ? 'Done.' : 'Already in that state — nothing changed.'); }
      else setMsg(d?.message || 'That did not work.');
    } catch { setMsg('We could not reach the server.'); }
    finally { setBusy(null); }
  }

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — affiliates</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-6xl">
        <h1 className="text-xl font-semibold text-ink">Affiliates</h1>
        <p className="mt-2 text-sm text-muted" data-testid="joining-state">
          {joiningOpen
            ? 'New affiliates can join: the public site shows the signup button.'
            : 'Joining is closed: the public site shows the waiting-list form instead of the signup button.'}
          {' '}Change it under <span className="text-ink">Billing</span>.
        </p>
        {msg && <p className="mt-3 text-sm text-ink" data-testid="affiliate-msg">{msg}</p>}

        {/* ── PAYEE REQUESTS, FIRST, BECAUSE THEY ARE THE ONLY THING HERE THAT IS WAITING ON ME ──
            An affiliate cannot be paid until these are applied, so a pending one is a blocked
            payment rather than a notification. The list is absent when empty — not an empty table,
            which reads as a feature that is not working. */}
        {reqs.length > 0 && (
          <>
            <h2 className="mt-8 text-base font-semibold text-ink">
              Bank details waiting for you{' '}
              <span className="text-muted font-normal" data-testid="payee-request-count">({reqs.length})</span>
            </h2>
            <p className="mt-1 text-xs text-muted">
              An affiliate proposes these; nothing is paid until you apply one. Applying copies the
              encrypted values across without showing them — revealing is a separate, recorded act.
            </p>
            <div className="mt-4 space-y-4" data-testid="payee-request-list">
              {reqs.map((q) => (
                <div key={q.id} className="border border-line rounded-lg p-4 bg-surface" data-testid="payee-request-row">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-ink font-medium">
                        {q.affiliateName} <span className="text-xs text-muted font-mono">{q.refCode}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {q.payeeKind === 'nominee' ? 'Pay a nominated person' : 'Pay the affiliate'} · asked {when(q.requestedAt)}
                      </p>
                      <p className="mt-2 text-sm text-ink" data-testid="payee-request-account">
                        {q.accountName} — <span className="font-mono">{q.masked}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {q.currentMasked
                          ? <>Replaces the account ending <span className="font-mono">{q.currentMasked}</span></>
                          : 'We hold no details for them yet.'}
                      </p>
                      {q.nomineeEmail && (
                        <p className="mt-2 text-xs text-ink" data-testid="payee-request-nominee">
                          Nominee: <span className="font-mono">{q.nomineeEmail}</span>
                        </p>
                      )}
                      {/* THE TWO LISTS, SIDE BY SIDE. lib/payee refuses an exact email match and says
                          in its header why it will not compare names — so the control is a person
                          looking at the nominee next to the people at the garages they introduced.
                          Printing them is what makes that control exist. */}
                      {q.payeeKind === 'nominee' && (
                        <div className="mt-2 text-xs text-muted" data-testid="payee-request-referred">
                          {q.referredPeople.length === 0 ? (
                            'They have referred no garages, so there is nobody for this to be.'
                          ) : (
                            <>
                              <span className="text-ink">People at the garages they introduced:</span>
                              <ul className="mt-1 space-y-0.5">
                                {q.referredPeople.map((pp) => (
                                  <li key={pp.email}>{pp.name ?? '(no name)'} · {pp.email} · {pp.garage}</li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="text-right space-y-2">
                      <button onClick={() => payeeAction({ action: 'apply', requestId: q.id }, `apply:${q.id}`)}
                        disabled={busy === `apply:${q.id}`} data-testid="payee-apply"
                        className="block w-full text-xs border border-line rounded-lg px-3 py-1.5 text-ink hover:bg-surface-muted disabled:opacity-50">
                        Apply
                      </button>
                      <button onClick={() => {
                        const reason = typeof window === 'undefined' ? '' : (window.prompt('Why are you rejecting it?') ?? '');
                        if (!reason.trim()) return;
                        payeeAction({ action: 'reject', requestId: q.id, reason }, `reject:${q.id}`);
                      }}
                        disabled={busy === `reject:${q.id}`} data-testid="payee-reject"
                        className="block w-full text-xs border border-line rounded-lg px-3 py-1.5 text-ink hover:bg-surface-muted disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 className="mt-8 text-base font-semibold text-ink">
          The affiliates <span className="text-muted font-normal" data-testid="affiliate-count">({rows.length})</span>
        </h2>
        <p className="mt-1 text-xs text-muted">
          Earnings are net of reversals. <span className="text-ink">Payable</span> is what has matured
          past the {holdDays}-day hold — owed, but not sendable until bank details exist.
        </p>

        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-muted" data-testid="affiliates-empty">Nobody has joined yet.</p>
        ) : (
          <div className="mt-4 space-y-4" data-testid="affiliate-list">
            {rows.map((a) => (
              <div key={a.id} data-testid="affiliate-row"
                className={`border rounded-lg p-4 ${a.suspendedAt ? 'border-warn bg-warn-soft' : 'border-line bg-surface'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-ink font-medium">
                      {a.name}
                      {a.suspendedAt && (
                        <span className="ml-2 text-xs text-warn font-semibold" data-testid="affiliate-suspended-badge">
                          SUSPENDED {when(a.suspendedAt)}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted">{a.email}{a.socialHandle ? ` · ${a.socialHandle}` : ''}</p>
                    <p className="mt-1 text-xs text-muted">
                      Code <span className="text-ink font-mono">{a.refCode}</span> · joined {when(a.joinedAt)}
                      {a.mobile ? ` · ${a.mobile}` : ' · no mobile'}
                    </p>
                    <p className="mt-1 text-xs flex flex-wrap gap-x-4">
                      <Verified at={a.mobileVerifiedAt} what="SMS" />
                      <Verified at={a.emailVerifiedAt} what="Email" />
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-ink" data-testid="affiliate-earned">Earned {money(a.earnedPennies)}</p>
                    <p className="text-xs text-muted">
                      Payable {money(a.payablePennies)} · held {money(a.heldPennies)}
                    </p>
                    {/* THREE STATES: details held, details revealed on this screen now, or none on
                        file. "None" is said in words rather than left as an empty line, because a
                        blank here reads as a screen that failed to load something. */}
                    {a.bankMasked ? (
                      revealed[a.id] ? (
                        <p className="mt-2 text-xs text-ink font-mono" data-testid="payee-revealed">
                          {revealed[a.id].sortCode} · {revealed[a.id].accountNumber}
                        </p>
                      ) : (
                        <>
                          <p className="mt-2 text-xs text-muted" data-testid="payee-held">
                            Bank <span className="font-mono">{a.bankMasked}</span>
                          </p>
                          <button onClick={() => reveal(a.id)} disabled={busy === `reveal:${a.id}`}
                            data-testid="payee-reveal"
                            className="mt-1 text-xs border border-line rounded-lg px-3 py-1.5 text-ink hover:bg-surface-muted disabled:opacity-50">
                            Show bank details
                          </button>
                        </>
                      )
                    ) : (
                      <p className="mt-2 text-xs text-muted" data-testid="payee-none">No bank details</p>
                    )}
                    <button onClick={() => toggle(a)} disabled={busy === a.id}
                      data-testid={a.suspendedAt ? 'affiliate-unsuspend' : 'affiliate-suspend'}
                      className="mt-2 text-xs border border-line rounded-lg px-3 py-1.5 text-ink hover:bg-surface-muted disabled:opacity-50">
                      {busy === a.id ? '…' : a.suspendedAt ? 'Unsuspend' : 'Suspend'}
                    </button>
                  </div>
                </div>

                {/* WHAT SUSPENSION IS DOING, on the row it is doing it to — which is where somebody
                    actually reads it, rather than in a paragraph at the top nobody returns to. */}
                {a.suspendedAt && (
                  <p className="mt-3 text-xs text-warn" data-testid="affiliate-suspended-note">
                    No new referrals are attributed to this code, no new garage gets the offer on it,
                    and nothing earns from {when(a.suspendedAt)}. Garages already referred keep their
                    frozen price, and nothing already earned has been reversed.
                  </p>
                )}

                <div className="mt-3">
                  <p className="text-xs text-muted">
                    Garages referred <span data-testid="affiliate-garage-count">({a.garages.length})</span>
                  </p>
                  {a.garages.length === 0 ? (
                    <p className="text-xs text-muted">None yet.</p>
                  ) : (
                    <ul className="mt-1 text-xs text-ink space-y-1" data-testid="affiliate-garages">
                      {a.garages.map((g) => (
                        <li key={g.groupId}>
                          {g.ref ? <span className="font-mono text-muted">{g.ref} </span> : null}{g.name}
                          {' — '}<span className="text-muted">{g.status}</span>
                          {g.everPaid ? '' : ' · never paid'}
                          {' · referred '}{when(g.referredAt)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <h2 className="mt-10 text-base font-semibold text-ink">
          Waiting list <span className="text-muted font-normal" data-testid="waitlist-count">({entries.length})</span>
        </h2>
        <p className="mt-1 text-xs text-muted">
          People who asked to be told when the programme opens. Not affiliates: nobody here has a code
          or has accepted any terms.
        </p>

        {entries.length === 0 ? (
          // NOT "no results". An empty list means nobody has asked, which is a fact about the
          // programme rather than a failed search — and it reads differently to an operator.
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
                    {/* THREE STATES HERE TOO: trade, creator, or they did not say. An em dash
                        rather than a blank cell, so "did not say" cannot be mistaken for a fault. */}
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
  const { listAffiliates, HOLD_DAYS } = await import('@/lib/affiliate-admin');
  const { listPayeeRequests } = await import('@/lib/payee-admin');

  // OLDEST FIRST on the waiting list: it is a queue, and the order people asked in is the order
  // they are told in. The affiliates are newest first — that is a list, not a queue.
  const rows = await prisma.affiliateWaitlist.findMany({
    orderBy: { created_at: 'asc' },
    select: { id: true, email: true, audience: true, created_at: true },
  });
  const terms = await currentTerms(prisma);
  const affiliates = await listAffiliates(prisma);
  const payeeRequests = await listPayeeRequests(prisma as any);

  return {
    props: {
      role: gate.op.role,
      joiningOpen: terms.joiningOpen,
      holdDays: HOLD_DAYS,
      // DATES AS STRINGS, because Next serialises props as JSON and a Date is not JSON. Field by
      // field rather than a blanket stringify, so a new Date field fails to compile here instead of
      // arriving at the browser as `{}`.
      affiliates: affiliates.map((a) => ({
        ...a,
        joinedAt: a.joinedAt.toISOString(),
        mobileVerifiedAt: a.mobileVerifiedAt ? a.mobileVerifiedAt.toISOString() : null,
        emailVerifiedAt: a.emailVerifiedAt ? a.emailVerifiedAt.toISOString() : null,
        termsAcceptedAt: a.termsAcceptedAt ? a.termsAcceptedAt.toISOString() : null,
        suspendedAt: a.suspendedAt ? a.suspendedAt.toISOString() : null,
        garages: a.garages.map((g) => ({ ...g, referredAt: g.referredAt.toISOString() })),
      })),
      entries: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
      payeeRequests: payeeRequests.map((q) => ({ ...q, requestedAt: q.requestedAt.toISOString() })),
    },
  };
};
