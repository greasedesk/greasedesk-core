/**
 * File: pages/admin/marketing.tsx
 * WHICH CARS ARE DUE, WHAT IT IS WORTH, AND WHO TO RING.
 *
 * Everything the intake work has captured since yesterday feeds a marketing list. This is the list.
 *
 * ── NOTHING HERE SENDS ──────────────────────────────────────────────────────────────────────────
 * The garage rings, texts or emails through the surfaces that already exist. This page answers
 * three questions and records what was done about the answer — bulk send is its own slice, and
 * shipping a send button beside an untested list is how a garage's first impression of a feature
 * becomes an apology to a hundred customers.
 *
 * ── AN OPT-OUT IS AN OPT-OUT OF EVERYTHING ──────────────────────────────────────────────────────
 * No adjudicating service versus offer. An opted-out customer still APPEARS — they are still due,
 * and a phone call is not an electronic message — with the phone number visible and the refused
 * channels named. See lib/marketing-lists for the cost of that rule, which is accepted knowingly.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { buildMotList, buildServiceList, type MarketingRow, type MotList, type ServiceList } from '@/lib/marketing-data';
import { WINDOW_DAYS } from '@/lib/marketing-lists';

type PageProps = { mot: MotList; service: ServiceList; currency: string };

const money = (pennies: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(pennies / 100);

const STATE_LABEL: Record<string, string> = {
  contacted: 'Contacted', booked: 'Booked', declined: 'Declined', snoozed: 'Snoozed',
};

function Row({ row, reason, onDone }: { row: MarketingRow; reason: 'mot' | 'service'; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function record(state: string) {
    setBusy(true);
    try {
      await fetch('/api/marketing-contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId: row.vehicleId, reason, state, forDate: row.dueDate }),
      });
      onDone();
    } finally { setBusy(false); }
  }
  const act = 'text-xs underline text-muted disabled:opacity-50';
  return (
    <li className="py-2.5 border-b border-line last:border-0" data-testid={`marketing-row-${row.vehicleId}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-ink tabular-nums">{row.registration}</span>
        {row.vehicleDesc && <span className="text-xs text-muted">{row.vehicleDesc}</span>}
        <span className="text-sm text-ink">{row.customerName ?? 'No owner recorded'}</span>
        {/* ALWAYS SHOWN. No opt-out covers a phone call. */}
        {row.phone && <span className="text-sm text-muted tabular-nums" data-testid="marketing-phone">{row.phone}</span>}
        {row.noContact && (
          <span className="text-xs font-medium text-warn" data-testid="marketing-no-contact">{row.noContact}</span>
        )}
        <span className="ml-auto text-xs text-muted">
          {/* THROUGH dueLabel, never the raw column. This showed "2026-11-01" to a garage, and once
              schedule rows carry month precision the raw value would also imply a day nobody chose. */}
          {row.dueLabel ?? row.triggerText}
          {row.mileageLegUnevaluated && <em className="not-italic"> · mileage leg not projected</em>}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-1.5">
        {row.state
          ? <span className="text-xs font-medium text-ok" data-testid="marketing-state">{STATE_LABEL[row.state] ?? row.state}</span>
          : <span className="text-xs text-muted">Not yet contacted</span>}
        <button type="button" disabled={busy} onClick={() => record('contacted')} className={act} data-testid="marketing-contacted">Contacted</button>
        <button type="button" disabled={busy} onClick={() => record('booked')} className={act} data-testid="marketing-booked">Booked</button>
        <button type="button" disabled={busy} onClick={() => record('declined')} className={act} data-testid="marketing-declined">Declined</button>
        <button type="button" disabled={busy} onClick={() => record('snoozed')} className={act} data-testid="marketing-snoozed">Snooze a month</button>
      </div>
    </li>
  );
}

function Band({ title, note, rows, reason, onDone }: {
  title: string; note?: string; rows: MarketingRow[]; reason: 'mot' | 'service'; onDone: () => void;
}) {
  if (!rows.length) return null;
  return (
    <section className="mb-6" data-testid={`marketing-band-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <h3 className="text-sm font-semibold text-ink">{title} <span className="text-muted font-normal">({rows.length})</span></h3>
      {note && <p className="text-xs text-muted mt-0.5 mb-1">{note}</p>}
      <ul>{rows.map((r) => <Row key={r.vehicleId} row={r} reason={reason} onDone={onDone} />)}</ul>
    </section>
  );
}

export default function MarketingPage({ mot, service, currency }: PageProps) {
  const [tab, setTab] = useState<'mot' | 'service'>('mot');
  const reload = () => window.location.reload();
  const list = tab === 'mot' ? mot : service;

  // NO AdminLayout HERE. _app wraps every /admin route in it, mounted ONCE and kept mounted across
  // navigations so the locations bar does not refetch and the shell does not tear down. Wrapping
  // again nested a second sidebar inside the first and broke the layout — and it also cost the
  // persistence the shell exists for, remounting the whole thing on every visit to this page.
  return (
    <>
      <Head><title>Marketing — GreaseDesk</title></Head>
      <h1 className="text-xl font-semibold text-ink mb-1">Marketing</h1>
      <p className="text-sm text-muted mb-4">
        Cars due in the next {WINDOW_DAYS} days. Nothing here sends — ring, text or email them the
        way you already do, then say what happened so the list clears.
      </p>

      <div className="flex gap-2 mb-4">
        {(['mot', 'service'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setTab(k)} data-testid={`marketing-tab-${k}`}
            className={`min-h-[40px] px-4 text-sm font-medium rounded-lg border ${tab === k ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`}>
            {k === 'mot' ? 'MOTs due soon' : 'Servicing likely due'}
          </button>
        ))}
      </div>

      {/* THE TILE. The method travels with the number rather than sitting underneath it as a
          caveat — "23 cars × your average job of £178" is readable; "£4,100 of work due" is a
          forecast nobody made. */}
      <div className="mb-5 rounded-xl border border-line bg-surface p-4" data-testid="marketing-revenue">
        {list.revenue.ok ? (
          <>
            <p className="text-2xl font-bold text-ink tabular-nums">{money(list.revenue.pennies, currency)}</p>
            <p className="text-xs text-muted">
              {list.revenue.cars} car{list.revenue.cars === 1 ? '' : 's'} ×{' '}
              {list.revenue.basis === 'mot_price'
                ? <>your MOT price of {money(list.revenue.averagePennies, currency)}</>
                : <>your average job of {money(list.revenue.averagePennies, currency)}</>}
              . {list.revenue.basis === 'mot_price'
                ? 'Exact if every one comes in.'
                : 'A rough figure from your own average, not a quote for these cars.'}
            </p>
          </>
        ) : (
          // A MISSING TILE READS AS A BUG; A SENTENCE READS AS SOMETHING YOU CAN FIX.
          <p className="text-sm text-muted" data-testid="marketing-revenue-none">
            {list.revenue.reason === 'no_price'
              ? 'No figure here — add an MOT to your products with a price and this will show what the list is worth. An average job value would overstate it.'
              : 'No figure here yet — it comes from your own average invoice, and there are no invoices from the last twelve months to average.'}
          </p>
        )}
      </div>

      {tab === 'mot' ? (
        <>
          <Band title="Expired" note="Off the road until it is done — the best call on this page." rows={mot.expired} reason="mot" onDone={reload} />
          <Band title="Due soon" rows={mot.due} reason="mot" onDone={reload} />
          {/* A LIST THAT SILENTLY OMITS 43% OF THE FLEET MISREPRESENTS ITSELF. */}
          {/* THREE NUMBERS, NOT ONE, AND ONLY THE ONES THAT ARE NOT ZERO. "95 cars have no MOT
              date" counted 6 too new to need one and 27 whose age we do not know — overstating the
              gap on a screen a garage is being asked to trust. And a line reading "0 of your 101
              cars have no MOT date" is the badge mistake in sentence form: nothing to report should
              report nothing. */}
          {(mot.missingMotDate > 0 || mot.unknownAge > 0) && (
            <p className="text-xs text-muted" data-testid="marketing-no-mot-date">
              {mot.missingMotDate > 0 && (
                <>{mot.missingMotDate} of your {mot.fleet} cars have no MOT date from DVSA. </>
              )}
              {mot.unknownAge > 0 && (
                <>{mot.unknownAge} {mot.unknownAge === 1 ? 'car has' : 'cars have'} no year recorded, so we can’t tell whether {mot.unknownAge === 1 ? 'it needs' : 'they need'} one. </>
              )}
              {mot.tooNewForMot > 0 && (
                <>{mot.tooNewForMot} {mot.tooNewForMot === 1 ? 'is' : 'are'} too new to need one.</>
              )}
            </p>
          )}
          {!mot.expired.length && !mot.due.length && (
            <p className="text-sm text-muted">Nothing due in the next {WINDOW_DAYS} days.</p>
          )}
        </>
      ) : (
        <>
          <Band title="Due by a date" rows={service.dated} reason="service" onDone={reload} />
          <Band title="Due on a trigger"
            note="No date to project — these are due at the next service, or at a mileage we cannot forecast. A car due at its next service is overdue a visit by definition."
            rows={service.trigger} reason="service" onDone={reload} />
          {!service.dated.length && !service.trigger.length && (
            <p className="text-sm text-muted">Nothing due in the next {WINDOW_DAYS} days.</p>
          )}
        </>
      )}
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  await getVisibility(user.id as string);
  const groupId = user.group_id as string;
  const now = new Date();

  const { prisma } = await import('@/lib/db');
  const site = await prisma.site.findFirst({ where: { group_id: groupId }, select: { currency_code: true } });
  const [mot, service] = await Promise.all([buildMotList(groupId, now), buildServiceList(groupId, now)]);
  return { props: { mot: JSON.parse(JSON.stringify(mot)), service: JSON.parse(JSON.stringify(service)), currency: site?.currency_code ?? 'GBP' } };
};
