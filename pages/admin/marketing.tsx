/**
 * File: pages/admin/marketing.tsx
 * THE PIPELINE. Three stacks, and what a car is doing in each one.
 *
 * ── IT IS REVENUE GENERATION, AND IT IS FOR EVERYONE IN THE BUILDING ────────────────────────────
 * This is what gets staff paid, so the board is visible to every role. What is NOT visible is
 * money: the version this replaces rendered "£1,214 of work due" — four cars times the tenant's
 * average job — to a STANDARD mechanic, with no permission check of any kind, on a page that never
 * consulted financeVisibility. There is now no figure on the board at all, so there is nothing to
 * leak; when value arrives it arrives shaped server-side like the diary's.
 *
 * A mechanic cannot ring a customer, but they can say "that car is in tomorrow and its battery is
 * dying" — which is the reason the board is not admin-only and the phone number is never hidden.
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
import { buildBoard, type Board, type BoardRow } from '@/lib/marketing-board';
import { WINDOW_DAYS } from '@/lib/marketing-lists';
import { checkedLabel } from '@/lib/mot-refresh';

type PageProps = { board: Board };

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

function Row({ row, reason, onDone }: { row: BoardRow; reason: 'mot' | 'service'; onDone: () => void }) {
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
          {/* STRUCK THROUGH, NOT REPLACED, when a DVSA check has moved the date. What the row
              used to say is why it is still sitting in this stack, and removing it would leave a
              renewed car looking mis-sorted. */}
          <span className={checked?.kind === 'changed' ? 'line-through text-muted/60' : undefined}
            data-testid="marketing-due-label">
            {row.reasons[0]?.text ?? ''}
          </span>
        </span>
      </div>

      {/* EVERY REASON, NOT JUST THE WINNING ONE. A car with an expired MOT AND a failed battery is
          a better call than one with either, and whoever rings should be able to say both. The
          first reason is in the line above; the rest sit here so the row stays one line tall when
          there is only one thing to say. Authored in lib/marketing-pipeline, not assembled here. */}
      {row.reasons.length > 1 && (
        <ul className="mt-1 space-y-0.5" data-testid={`row-reasons-${row.vehicleId}`}>
          {row.reasons.slice(1).map((r, i) => (
            <li key={i} className={`text-xs ${r.stack === 'hot' ? 'text-warn' : 'text-muted'}`} data-kind={r.kind}>
              · {r.text}
            </li>
          ))}
        </ul>
      )}
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

/**
 * A STACK, not a band. The heading carries the count and the sentence that says what this stack
 * MEANS — "money available this week" is the instruction; "Hot" alone is a colour.
 */
function Stack({ title, meaning, rows, onDone }: {
  title: string; meaning: string; rows: BoardRow[]; onDone: () => void;
}) {
  return (
    <section className="mb-6" data-testid={`stack-${title.toLowerCase()}`}>
      {/* THE COUNT DOES NOT MOVE WHEN A ROW IS CHECKED, and that is deliberate rather than a bug.
          A car whose MOT turns out to be renewed stays in this stack, struck through, so nobody
          loses their place in a list they are working — and a count that decremented while the
          rows it counts deliberately stayed put would be the same disorientation in miniature. It
          is briefly stale by design; the next load reconciles it, because the stacks are computed
          on load and nothing is stored. */}
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className="text-sm text-muted tabular-nums" data-testid={`stack-count-${title.toLowerCase()}`}>{rows.length}</span>
      </div>
      <p className="text-xs text-muted mt-0.5 mb-2">{meaning}</p>
      {/* AN EMPTY STACK SAYS SO. A heading with nothing under it reads as a loading failure; the
          board's own prompt (below) explains WHY Hot is empty when it is. */}
      {rows.length === 0
        ? <p className="text-xs text-muted italic" data-testid={`stack-empty-${title.toLowerCase()}`}>Nothing here.</p>
        : <ul>{rows.map((r) => <Row key={r.vehicleId} row={r} reason="mot" onDone={onDone} />)}</ul>}
    </section>
  );
}

export default function MarketingPage({ board }: PageProps) {
  const reload = () => window.location.reload();

  // NO AdminLayout HERE. _app wraps every /admin route in it, mounted ONCE and kept mounted across
  // navigations so the locations bar does not refetch and the shell does not tear down. Wrapping
  // again nested a second sidebar inside the first and broke the layout.
  return (
    <>
      <Head><title>Marketing — GreaseDesk</title></Head>
      <h1 className="text-xl font-semibold text-ink mb-1">Marketing</h1>
      <p className="text-sm text-muted mb-4">
        Who to ring, in the order worth ringing them. A car moves down when the customer answers
        and comes back up when its clock comes round.
      </p>

      {/* ── A COUNT, NOT A VALUE ────────────────────────────────────────────────────────────────
          What replaced "£1,214 of work due", which was four cars times the tenant's average job
          and described none of them. A count is true. Value when the ordering has earned it —
          and when it comes, it comes shaped by financeVisibility, not rendered to everyone. */}
      <div className="mb-5 rounded-xl border border-line bg-surface p-4" data-testid="board-summary">
        <p className="text-2xl font-bold text-ink tabular-nums">
          {board.hot.length} <span className="text-base font-medium text-muted">worth ringing today</span>
        </p>
        <p className="text-xs text-muted mt-0.5">
          {board.warm.length} warm · {board.later.length} later · {board.fleet} cars on the books
        </p>
        {/* THE BOARD EXPLAINS ITS OWN EMPTINESS. An empty Hot stack is usually not a quiet week —
            it is the answer nobody recorded. Saying so is the argument for recording it. */}
        {board.prompt && (
          <p className="text-xs text-accent mt-2" data-testid="board-prompt">{board.prompt}</p>
        )}
      </div>

      <Stack title="Hot" meaning="Money available this week. They will say yes."
        rows={board.hot} onDone={reload} />
      <Stack title="Warm" meaning={`Due within ${WINDOW_DAYS} days, plausible, not urgent.`}
        rows={board.warm} onDone={reload} />
      <Stack title="Later" meaning="Declined, snoozed, or genuinely distant. They come back up when their clock comes round."
        rows={board.later} onDone={reload} />
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  // Site scope only. NO role gate: the board is for everyone in the building, and it carries no
  // money to gate — see the header.
  await getVisibility(user.id as string);
  // COMPUTED HERE, ON EVERY LOAD. No stack column, nothing scheduled: every input is a stored date
  // or reading compared against `now`, so time promotes for free and a stale board is impossible.
  const board = await buildBoard(user.group_id as string, new Date());
  return { props: { board: JSON.parse(JSON.stringify(board)) } };
};
