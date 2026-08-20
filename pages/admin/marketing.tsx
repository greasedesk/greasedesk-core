/**
 * File: pages/admin/marketing.tsx
 * WHICH CARS ARE DUE, WHAT IT IS WORTH, AND WHO TO RING.
 *
 * Everything the intake work has captured since yesterday feeds a marketing list. This is the list.
 *
 * ── IT SENDS NOW, ONE ROW AT A TIME ─────────────────────────────────────────────────────────────
 * It did not, and the reason it did not still holds: shipping a BULK send button beside an
 * untested list is how a garage's first impression of a feature becomes an apology to a hundred
 * customers. What ships here is per-row and two-pressed — open the panel, see the exact words the
 * customer will receive, then send. Bulk remains its own slice, deliberately.
 *
 * ── EXCEPT THE CHECK, WHICH ASKS DVSA RATHER THAN THE CUSTOMER ──────────────────────────────────
 * Every MOT row carries a Check button. It is not a repair for rows that look wrong: any stored
 * MOT date is stale the moment it is stored, because the car can be tested anywhere and we hear
 * about it only when we look. It belongs beside the phone number as a normal step — check, then
 * ring. See pages/api/mot-refresh for what it writes and lib/mot-refresh for what it says.
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
import { checkedLabel } from '@/lib/mot-refresh';

type PageProps = { mot: MotList; service: ServiceList; currency: string };

const money = (pennies: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(pennies / 100);

const STATE_LABEL: Record<string, string> = {
  contacted: 'Contacted', booked: 'Booked', declined: 'Declined', snoozed: 'Snoozed',
};

/**
 * The channel qualifies the state, it does not replace it. "Texted" as a fifth word would make a
 * garage choose between two names for one fact — a texted car IS a contacted car. NULL says
 * nothing extra rather than guessing: those rows were a phone call, or predate sending entirely.
 */
const CHANNEL_SUFFIX: Record<string, string> = { sms: ' by text', email: ' by email', both: ' by text and email' };

function Row({ row, reason, onDone }: { row: MarketingRow; reason: 'mot' | 'service'; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  // ── THE CHECK LIVES IN THE ROW, AND THE ROW DOES NOT MOVE ─────────────────────────────────────
  // Every other action here ends in a full reload, which is right for them: recording a contact is
  // finished business and the row should go. A check is the opposite — it happens WHILE someone is
  // working the list, often seconds before they dial. Re-sorting or removing the row under their
  // cursor loses their place in a list they are working, so the result is rendered in place and
  // the page reconciles on its next natural load.
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ kind: string; sentence: string; stillDue: boolean } | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(row.motCheckedAt);
  // ── SENDING OPENS A PANEL, IT DOES NOT FIRE ──────────────────────────────────────────────────
  // One press on a list of two hundred rows must not put words on a customer's phone. The panel
  // shows exactly what will go — rendered by the SERVER, from the same template that sends it —
  // and the send is a second, deliberate press.
  const [panel, setPanel] = useState<any | null>(null);
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Record<string, { ok: boolean; message: string }> | null>(null);
  const [want, setWant] = useState<{ sms: boolean; email: boolean }>({ sms: false, email: false });
  async function openPanel() {
    if (panel) { setPanel(null); return; }
    setOpening(true);
    try {
      const r = await fetch(`/api/marketing-send?vehicleId=${encodeURIComponent(row.vehicleId)}`);
      const j = await r.json().catch(() => null);
      if (j?.template) { setPanel(j); setWant({ sms: !!j.canSms, email: !!j.canEmail && !j.canSms }); }
      else setPanel({ error: j?.message ?? 'Could not prepare the message.' });
    } finally { setOpening(false); }
  }
  async function send() {
    const channels = [want.sms && 'sms', want.email && 'email'].filter(Boolean);
    if (!channels.length) return;
    setSending(true);
    try {
      const r = await fetch('/api/marketing-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId: row.vehicleId, channels }),
      });
      const j = await r.json().catch(() => null);
      setSent(j?.results ?? { error: { ok: false, message: j?.message ?? 'The send didn’t complete.' } });
    } catch {
      setSent({ error: { ok: false, message: 'The send didn’t complete.' } });
    } finally { setSending(false); }
  }

  async function check() {
    setChecking(true);
    try {
      const r = await fetch('/api/mot-refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId: row.vehicleId }),
      });
      const j = await r.json().catch(() => null);
      if (j?.outcome) { setChecked(j.outcome); if (j.checkedAt) setCheckedAt(j.checkedAt); }
      // A THROWN FETCH SAYS SO. Leaving the row silent after a press would read as "no change".
      else setChecked({ kind: 'no_answer', sentence: 'The check didn’t complete — nothing was learned.', stillDue: true });
    } catch {
      setChecked({ kind: 'no_answer', sentence: 'The check didn’t complete — nothing was learned.', stillDue: true });
    } finally { setChecking(false); }
  }
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
          {/* STRUCK THROUGH, NOT REPLACED. What it used to say is why the row is still sitting in
              the Expired band, and removing it would leave a renewed car looking mis-sorted. */}
          <span className={checked?.kind === 'changed' ? 'line-through text-muted/60' : undefined}
            data-testid="marketing-due-label">
            {row.dueLabel ?? row.triggerText}
          </span>
          {row.mileageLegUnevaluated && <em className="not-italic"> · mileage leg not projected</em>}
        </span>
      </div>
      {checked && (
        <p className={`text-xs mt-1 ${checked.kind === 'no_answer' ? 'text-warn' : checked.kind === 'changed' ? 'text-ok' : 'text-muted'}`}
          data-testid="marketing-check-result" data-kind={checked.kind}>
          {checked.sentence}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 mt-1.5">
        {row.state
          ? <span className="text-xs font-medium text-ok" data-testid="marketing-state">
              {STATE_LABEL[row.state] ?? row.state}
              {row.state === 'contacted' && row.channel ? CHANNEL_SUFFIX[row.channel] ?? '' : ''}
            </span>
          : <span className="text-xs text-muted">Not yet contacted</span>}
        <button type="button" disabled={busy} onClick={() => record('contacted')} className={act} data-testid="marketing-contacted">Contacted</button>
        <button type="button" disabled={busy} onClick={() => record('booked')} className={act} data-testid="marketing-booked">Booked</button>
        <button type="button" disabled={busy} onClick={() => record('declined')} className={act} data-testid="marketing-declined">Declined</button>
        <button type="button" disabled={busy} onClick={() => record('snoozed')} className={act} data-testid="marketing-snoozed">Snooze a month</button>
        {/* MOT ROWS ONLY. A service row's date comes from a schedule reading we took ourselves;
            there is nothing to check it against, and a button that can only ever say "no change"
            is worse than no button. */}
        {reason === 'mot' && (
          <>
            <button type="button" disabled={checking} onClick={check}
              className="text-xs underline text-accent disabled:opacity-50" data-testid="marketing-check">
              {checking ? 'Checking…' : 'Check with DVSA'}
            </button>
            {checkedAt && (
              <span className="text-xs text-muted" data-testid="marketing-checked-at">
                {checkedLabel(checkedAt, new Date())}
              </span>
            )}
            <button type="button" disabled={opening} onClick={openPanel}
              className="text-xs underline text-accent disabled:opacity-50" data-testid="marketing-send-open">
              {opening ? 'Preparing…' : panel ? 'Close' : 'Send a reminder'}
            </button>
          </>
        )}
      </div>
      {panel && (
        <div className="mt-2 rounded-lg border border-line bg-canvas p-3" data-testid="marketing-send-panel">
          {panel.error ? <p className="text-xs text-warn">{panel.error}</p> : (
            <>
              {/* THE WORDS, AS THEY WILL ARRIVE. Rendered server-side through smsText, so this is
                  the transmitted text — not a hopeful copy of it. */}
              {panel.sms?.text && (
                <p className="text-xs text-ink whitespace-pre-wrap" data-testid="marketing-send-preview">{panel.sms.text}</p>
              )}
              {panel.sms && (
                <p className="text-[11px] text-muted mt-1" data-testid="marketing-send-cost">
                  {panel.sms.septets} of 160 · {panel.sms.segments === 1 ? 'one text' : `${panel.sms.segments} texts`}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3 mt-2">
                {(['sms', 'email'] as const).map((ch) => {
                  const can = ch === 'sms' ? panel.canSms : panel.canEmail;
                  const why = ch === 'sms' ? panel.smsWhyNot : panel.emailWhyNot;
                  return (
                    <label key={ch} className={`text-xs flex items-center gap-1.5 ${can ? 'text-ink' : 'text-muted'}`}
                      title={why ?? undefined} data-testid={`marketing-send-${ch}`}>
                      <input type="checkbox" disabled={!can} checked={can && want[ch]}
                        onChange={(e) => setWant((w) => ({ ...w, [ch]: e.target.checked }))} />
                      {ch === 'sms' ? 'Text' : 'Email'}
                      {/* A REFUSAL AND A MISSING ADDRESS ARE DIFFERENT PROBLEMS, fixed in different
                          places, so the row says which one it is rather than greying out silently. */}
                      {!can && why && <span className="text-[11px]">— {why}</span>}
                    </label>
                  );
                })}
                <button type="button" disabled={sending || (!want.sms && !want.email)} onClick={send}
                  className="text-xs font-medium rounded-lg border border-accent bg-accent text-white px-3 py-1.5 disabled:opacity-40"
                  data-testid="marketing-send-go">{sending ? 'Sending…' : 'Send'}</button>
              </div>
              {/* NEITHER CHANNEL, AND A NUMBER INSTEAD. Roughly one customer in five on a real
                  fleet can only be phoned, and the list has always shown the number for them. */}
              {!panel.canSms && !panel.canEmail && panel.phone && (
                <p className="text-xs text-muted mt-2" data-testid="marketing-send-ring">
                  Nothing to send to — ring {panel.phone}.
                </p>
              )}
              {sent && (
                <ul className="mt-2 space-y-0.5" data-testid="marketing-send-result">
                  {Object.entries(sent).map(([ch, r]: any) => (
                    <li key={ch} className={`text-xs ${r.ok ? 'text-ok' : 'text-warn'}`} data-ok={r.ok ? '1' : '0'}>{r.message}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Band({ title, note, rows, reason, onDone }: {
  title: string; note?: string; rows: MarketingRow[]; reason: 'mot' | 'service'; onDone: () => void;
}) {
  if (!rows.length) return null;
  return (
    <section className="mb-6" data-testid={`marketing-band-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      {/* THE COUNT DOES NOT MOVE WHEN A ROW IS CHECKED, and that is deliberate rather than a bug.
          A car whose MOT turns out to be renewed stays in this band, struck through, so nobody
          loses their place — and a count that decremented while the rows it counts deliberately
          stayed put would be the same disorientation in miniature. It is briefly stale by design;
          the next load reconciles it. */}
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
        Cars due in the next {WINDOW_DAYS} days. Send a reminder from the row, or ring them and say
        what happened, so the list clears.
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
