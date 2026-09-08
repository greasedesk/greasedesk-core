/**
 * File: pages/superadmin/pay-runs.tsx
 * SALES COMMISSION — the area manager's release screen.
 *
 * One rep, one open run. Per claimed month it shows the EVIDENCE and nothing inferred from its
 * absence: the garage and that it signed up under this rep's ?ref=, the scan and its date or
 * explicitly no scan, pass/fail against the fourteen-day rule WITH the dates that decided it, and
 * the garage's own last sign-in or explicitly never.
 *
 * ── HONEST NULL, EVERYWHERE ─────────────────────────────────────────────────────────────────────
 * Missing evidence renders as missing. An absent scan is not a zero and not a dash-date; a garage
 * that has never signed in says so rather than showing a fabricated time; an unreleased line still
 * shows its £30, because "not yet approved" and "worth nothing" are different facts and only one of
 * them is true.
 *
 * ── LANGUAGE ────────────────────────────────────────────────────────────────────────────────────
 * Sales Commission. A rep is self-employed and invoices us for it. Never wage, never salary, never
 * "pay" as a noun for the rep.
 *
 * Gated at country_manager — the same minRole ER_NAV filters the link on, enforced here
 * independently so a hidden link is never mistaken for a guard. Closing is the owner's and the API
 * asks for that separately; this screen shows the control and lets the server refuse.
 */
import Head from 'next/head';
import React from 'react';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorPage, operatorTenantScope, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import { windowVerdict, isArrears, runEligibleToClose, canEditPayRun, HOLD_REASONS, RELEASE_OVERRIDE_REASONS } from '@/lib/rep-pay-run';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Line = {
  entryId: string;
  period: string;
  garage: string;
  garageRef: string | null;
  /** TRUE when the garage's attribution came from a ?ref= link rather than a manual assignment. */
  fromRefLink: boolean;
  amountPennies: number;
  status: string;
  heldReason: string | null;
  /** ISO, or NULL when there is no scan for this month. NULL renders as "No scan recorded". */
  scanAt: string | null;
  previousScanAt: string | null;
  windowPass: boolean | null;
  daysSince: number | null;
  /** ISO, or NULL when nobody at the garage has ever signed in. NULL renders as "Never signed in". */
  lastLoginAt: string | null;
  arrears: boolean;
};
type Run = { id: string; period: string; scheduledOn: string; status: string; eligible: boolean } | null;
type Props = { role: OperatorRoleName; run: Run; lines: Line[]; totalPennies: number; holdReasons: string[]; overrideReasons: string[] };

const money = (p: number) => `£${(p / 100).toFixed(2)}`;
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/** The one place an absence becomes words. Never a zero, never a dash-date. */
function Missing({ what }: { what: string }) {
  return <span className="text-muted italic" data-testid="missing">{what}</span>;
}

export default function PayRuns({ role, run, lines, totalPennies, holdReasons, overrideReasons }: Props) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [signoff, setSignoff] = React.useState('');

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const r = await fetch('/api/superadmin/pay-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) window.location.reload();
    } finally { setBusy(null); }
  }

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Sales Commission — Engine Room</title><meta name="robots" content="noindex" /></Head>

      {!run ? (
        <p className="text-sm text-muted" data-testid="no-run">No Sales Commission run is open.</p>
      ) : (
        <>
          <div className="mb-4" data-testid="run-header">
            <h1 className="text-lg font-semibold text-ink">Sales Commission — {run.period}</h1>
            <p className="text-sm text-muted">
              Scheduled to close {dt(run.scheduledOn)}.{' '}
              {run.eligible
                ? <span data-testid="run-eligible">Eligible to close.</span>
                : <span data-testid="run-not-eligible">Not yet at its scheduled date — you may still close it.</span>}
            </p>
            <p className="text-sm text-ink mt-1" data-testid="run-total">
              {lines.length} line{lines.length === 1 ? '' : 's'} · {money(totalPennies)}
            </p>
          </div>

          <ul className="space-y-3">
            {lines.map((l) => (
              <li key={l.entryId} className="border border-line rounded-lg p-4 bg-surface" data-testid={`line-${l.entryId}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-semibold text-ink">
                    {l.garage}
                    {l.arrears && <span className="ml-2 text-xs text-warn" data-testid="arrears">Arrears — {l.period}</span>}
                  </div>
                  {/* An unreleased line is worth £30. It has not been approved; that is a different fact. */}
                  <div className="text-sm text-ink" data-testid="line-amount">{money(l.amountPennies)}</div>
                </div>

                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                  <dt className="text-muted">Signed up under</dt>
                  <dd data-testid="line-ref">
                    {l.fromRefLink && l.garageRef
                      ? <>this rep&rsquo;s <code>?ref={l.garageRef}</code></>
                      : <Missing what="Not from a ?ref= link" />}
                  </dd>

                  <dt className="text-muted">Visit scan</dt>
                  <dd data-testid="line-scan">
                    {l.scanAt ? dt(l.scanAt) : <Missing what="No scan recorded" />}
                  </dd>

                  <dt className="text-muted">Fourteen-day rule</dt>
                  <dd data-testid="line-window">
                    {l.windowPass === null
                      ? <Missing what="Nothing to judge — no scan" />
                      : (
                        <>
                          <span className={l.windowPass ? 'text-ok' : 'text-warn'}>{l.windowPass ? 'Pass' : 'Fail'}</span>
                          {l.daysSince != null && l.previousScanAt
                            ? <> — {l.daysSince} day{l.daysSince === 1 ? '' : 's'} since {dt(l.previousScanAt)}</>
                            : <> — no earlier visit to measure from</>}
                        </>
                      )}
                  </dd>

                  <dt className="text-muted">Garage last signed in</dt>
                  <dd data-testid="line-login">
                    {l.lastLoginAt ? dt(l.lastLoginAt) : <Missing what="Never signed in" />}
                  </dd>
                </dl>

                {l.status === 'held' && (
                  <p className="mt-2 text-xs text-warn" data-testid="line-held">Held — {l.heldReason}</p>
                )}

                <div className="mt-3 flex flex-wrap gap-2 items-center">
                  <button
                    type="button" disabled={busy === l.entryId} data-testid={`release-${l.entryId}`}
                    onClick={() => {
                      const needs = l.windowPass === false || !l.scanAt;
                      const reason = needs ? window.prompt(`Why release this line?\n${overrideReasons.join('\n')}`) : null;
                      if (needs && !reason) return;
                      void post({ action: 'release', entryId: l.entryId, runId: run.id, overrideReason: reason }, l.entryId);
                    }}
                    className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium disabled:opacity-50"
                  >Release</button>
                  <button
                    type="button" disabled={busy === l.entryId} data-testid={`hold-${l.entryId}`}
                    onClick={() => {
                      const reason = window.prompt(`Why hold this line?\n${holdReasons.join('\n')}`);
                      if (!reason) return;
                      void post({ action: 'hold', entryId: l.entryId, holdReason: reason }, l.entryId);
                    }}
                    className="px-3 py-1.5 rounded border border-line text-xs disabled:opacity-50"
                  >Hold</button>
                </div>
              </li>
            ))}
            {lines.length === 0 && <li className="text-sm text-muted" data-testid="no-lines">Nothing to review in this run.</li>}
          </ul>

          {canEditPayRun({ status: run.status }) && (
            <div className="mt-6 border-t border-line pt-4" data-testid="close-run">
              <label className="block text-xs text-muted mb-1" htmlFor="signoff">Sign off what you checked</label>
              <textarea
                id="signoff" data-testid="signoff" value={signoff} onChange={(e) => setSignoff(e.target.value)}
                className="w-full border border-line rounded p-2 text-sm bg-surface text-ink" rows={2}
              />
              <button
                type="button" disabled={busy === 'close'} data-testid="close-submit"
                onClick={() => void post({ action: 'close', runId: run.id, signoff }, 'close')}
                className="mt-2 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium disabled:opacity-50"
              >Close this run</button>
              <p className="mt-1 text-xs text-muted">
                Closing freezes the run. Lines held now join whichever run is open when they are released.
              </p>
            </div>
          )}
        </>
      )}
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/pay-runs') });
  if (!gate.ok) return { notFound: true };
  const op = gate.op;

  const run = await prisma.repPayRun.findFirst({ where: { status: 'open' }, orderBy: { opened_at: 'desc' } });
  if (!run) return { props: { role: op.role, run: null, lines: [], totalPennies: 0, holdReasons: [...HOLD_REASONS], overrideReasons: [...RELEASE_OVERRIDE_REASONS] } };

  // REGION SCOPE. CommissionEntry carries a bare group_id, so the scope resolves to ids first — an
  // operator with no regions gets an empty list and therefore no lines, failing closed.
  const scopeIds = (await prisma.group.findMany({ where: { ...operatorTenantScope(op) }, select: { id: true } })).map((g) => g.id);
  const entries = await prisma.commissionEntry.findMany({
    where: { group_id: { in: scopeIds }, kind: 'accrual', status: { in: ['pending', 'held'] } },
    orderBy: [{ period: 'asc' }],
    select: { id: true, group_id: true, party_type: true, party_id: true, period: true, amount_pennies: true, status: true, held_reason: true },
  });

  const groups = await prisma.group.findMany({
    where: { id: { in: entries.map((e) => e.group_id) } },
    select: { id: true, group_name: true, ref: true, users: { select: { last_login_at: true }, orderBy: { last_login_at: 'desc' }, take: 1 } },
  });
  const attributions = await prisma.tenantAttribution.findMany({
    where: { group_id: { in: entries.map((e) => e.group_id) } },
    select: { group_id: true, party_id: true, source: true },
  });
  const visits = await prisma.repVisit.findMany({
    where: { group_id: { in: entries.map((e) => e.group_id) }, satisfies_period: { not: null } },
    orderBy: { scanned_at: 'desc' },
    select: { group_id: true, party_id: true, scanned_at: true, satisfies_period: true },
  });

  const lines: Line[] = entries.map((e) => {
    const g = groups.find((x) => x.id === e.group_id);
    const mine = visits.filter((v) => v.group_id === e.group_id && v.party_id === e.party_id);
    const match = mine.find((v) => v.satisfies_period === e.period) ?? null;
    const previous = mine.find((v) => (v.satisfies_period ?? '') < e.period) ?? null;
    const verdict = windowVerdict({ period: e.period, visitAt: match?.scanned_at ?? null, previousVisitAt: previous?.scanned_at ?? null });
    const attr = attributions.find((a) => a.group_id === e.group_id && a.party_id === e.party_id) ?? null;
    return {
      entryId: e.id,
      period: e.period,
      garage: g?.group_name ?? 'Unknown garage',
      garageRef: g?.ref ?? null,
      fromRefLink: attr?.source === 'ref_param',
      amountPennies: e.amount_pennies,
      status: e.status,
      heldReason: e.held_reason,
      scanAt: match ? match.scanned_at.toISOString() : null,
      previousScanAt: previous ? previous.scanned_at.toISOString() : null,
      windowPass: verdict.pass,
      daysSince: verdict.daysSince,
      lastLoginAt: g?.users?.[0]?.last_login_at ? g.users[0].last_login_at.toISOString() : null,
      arrears: isArrears(e.period, run.period),
    };
  });

  return {
    props: {
      role: op.role,
      run: {
        id: run.id, period: run.period, scheduledOn: run.scheduled_on.toISOString(),
        status: run.status, eligible: runEligibleToClose(run, new Date()),
      },
      lines,
      totalPennies: lines.reduce((a, l) => a + l.amountPennies, 0),
      holdReasons: [...HOLD_REASONS],
      overrideReasons: [...RELEASE_OVERRIDE_REASONS],
    },
  };
};
