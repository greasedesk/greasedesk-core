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
import React, { useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
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

/**
 * NO `reason` PROP. It was 'mot' | 'service' — the names of the two lists this board used to be —
 * and the Stack passed a hardcoded 'mot' for every row, so a car rung about a failed battery
 * recorded a contact saying the call was about its MOT. The row already knows what it is: its own
 * strongest reason, the same one printed on the line the caller is reading.
 */
function Row({ row, onDone }: { row: BoardRow; onDone: () => void }) {
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
        body: JSON.stringify({ vehicleId: row.vehicleId, reason: row.reasons[0]?.kind, state, forDate: row.dueDate }),
      });
      onDone();
    } finally { setBusy(false); }
  }
  const act = 'text-xs underline text-muted disabled:opacity-50';
  return (
    // data-reg so ORDER is assertable by a stable identifier: a gate reading uuids has to map
    // them back, and the sequence is the thing under test.
    <li className="py-2.5 border-b border-line last:border-0" data-testid={`marketing-row-${row.vehicleId}`}
      data-reg={row.registration} data-urgency={row.urgency}>
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
        {/* EVERY ROW NOW. This was gated on `reason === 'mot'`, because a service row's date came
            from a schedule reading we took ourselves and there was nothing to check it against.
            The board is one row per CAR — every row has a registration, DVSA has an answer for
            every registration, and a stored MOT date is stale the moment it is stored whatever
            else the car is on the board for. The old gate was about which LIST a row came from,
            and the lists are gone. */}
        {true && (
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
 * ONE STACK'S ROWS. The heading and the count moved to the tab strip, which is now where a garage
 * reads the shape of the day without clicking — "Hot (6) · Warm (19) · Later (0)".
 */
function StackRows({ rows, empty, onDone }: { rows: BoardRow[]; empty: string; onDone: () => void }) {
  // AN EMPTY TAB SAYS WHY, not just that it is empty. On a tabbed board this matters more than it
  // did stacked: you land on Hot, and if it is empty that is the whole screen. See the prompt in
  // the summary above, which is the sentence that turns it from "this does nothing" into "here is
  // what makes it work".
  if (!rows.length) return <p className="text-sm text-muted italic" data-testid="stack-empty">{empty}</p>;
  return <ul>{rows.map((r) => <Row key={r.vehicleId} row={r} onDone={onDone} />)}</ul>;
}

// Three questions a garage asks of a call list: which car, whose car, how soon.
const SORTS = [
  { key: 'registration' as const, label: 'Reg', width: 'w-28' },
  { key: 'customer' as const, label: 'Customer', width: 'flex-1' },
  { key: 'urgency' as const, label: 'Urgency', width: 'w-24' },
];
type SortKey = typeof SORTS[number]['key'];

const STACKS = [
  { key: 'hot' as const, label: 'Hot', meaning: 'Money available this week. They will say yes.',
    empty: 'Nothing hot right now.' },
  { key: 'warm' as const, label: 'Warm', meaning: `Due within ${WINDOW_DAYS} days, plausible, not urgent.`,
    empty: 'Nothing warm — no MOTs or findings coming due.' },
  { key: 'later' as const, label: 'Later', meaning: 'Declined, snoozed, or genuinely distant. They come back up when their clock comes round.',
    empty: 'Nothing here yet. A car lands here when somebody answers.' },
];

export default function MarketingPage({ board }: PageProps) {
  const router = useRouter();
  // ── THE TAB LIVES IN THE URL ──────────────────────────────────────────────────────────────────
  // Not component state. Recording a contact reloads the page, and a garage working the Warm tab
  // should not be thrown back to Hot every time they mark a car — which is what component state
  // would do. It is also the state a gate can drive, rather than a strip it has to click.
  const active = STACKS.find((s) => s.key === router.query.stack)?.key ?? 'hot';
  // ── THE SORT LIVES IN THE URL TOO, BESIDE THE TAB ────────────────────────────────────────────
  // Same reasoning, same place: recording a contact reloads, and a garage working the list by
  // customer name should not be thrown back to urgency order every time they mark a car. Nothing
  // is stored — the value is recomputed each build, so there is nothing to go stale.
  const sortKey = (SORTS.find((c) => c.key === router.query.sort)?.key ?? 'urgency') as SortKey;
  const desc = router.query.dir === 'desc';
  const rows = useMemo(() => {
    const dir = desc ? -1 : 1;
    // REGISTRATION BREAKS EVERY TIE. Urgency ties are common — three cars at 1, three at 12 — and
    // the underlying row order is the vehicles query, which has no ORDER BY. Without this the list
    // reshuffles between page loads while claiming to be sorted, which is worse than unsorted.
    return [...board[active]].sort((a, b) => {
      const by = sortKey === 'registration' ? a.registration.localeCompare(b.registration)
        : sortKey === 'customer' ? (a.customerName ?? '').localeCompare(b.customerName ?? '')
        : a.urgency - b.urgency;
      return by !== 0 ? by * dir : a.registration.localeCompare(b.registration);
    });
  }, [board, active, sortKey, desc]);
  const select = (k: string) =>
    router.replace({ pathname: router.pathname, query: { ...router.query, stack: k } }, undefined, { shallow: true });
  // Click a column to sort by it; click the one already active to reverse it.
  const sortBy = (k: SortKey) =>
    router.replace({ pathname: router.pathname,
      query: { ...router.query, sort: k, dir: sortKey === k && !desc ? 'desc' : 'asc' } }, undefined, { shallow: true });
  const reload = () => window.location.reload();

  return (
    <>
      <Head><title>Marketing — GreaseDesk</title></Head>
      <h1 className="text-xl font-semibold text-ink mb-1">Marketing</h1>
      <p className="text-sm text-muted mb-4">
        Who to ring. A car drops to Later when the customer answers — a snooze comes back when its
        clock comes round; a no stays.
      </p>

      {/* ── A COUNT, NOT A VALUE ────────────────────────────────────────────────────────────────
          What replaced "£1,214 of work due", which was four cars times the tenant's average job
          and described none of them. Value when the ordering has earned it — and when it comes, it
          comes shaped by financeVisibility, not rendered to everyone.

          The per-stack counts moved to the tab strip, so the second line here is the fleet alone. */}
      <div className="mb-5 rounded-xl border border-line bg-surface p-4" data-testid="board-summary">
        <p className="text-2xl font-bold text-ink tabular-nums">
          {board.hot.length} <span className="text-base font-medium text-muted">worth ringing today</span>
        </p>
        <p className="text-xs text-muted mt-0.5">{board.fleet} cars on the books</p>
        {board.prompt && (
          <p className="text-xs text-accent mt-2" data-testid="board-prompt">{board.prompt}</p>
        )}
      </div>

      {/* COUNTS ON THE TABS, so the shape of the day is readable without clicking.

          THE COUNT DOES NOT MOVE WHEN A ROW IS CHECKED, and that is deliberate rather than a bug.
          A car whose MOT turns out to be renewed stays in its tab, struck through, so nobody loses
          their place in a list they are working — and a count that decremented while the rows it
          counts deliberately stayed put would be the same disorientation in miniature. It is
          briefly stale by design; the next load reconciles it, because the stacks are computed on
          load and nothing is stored. */}
      <div className="flex gap-2 mb-3" role="tablist">
        {STACKS.map((s) => (
          <button key={s.key} type="button" role="tab" aria-selected={active === s.key}
            onClick={() => select(s.key)} data-testid={`stack-tab-${s.key}`}
            className={`min-h-[40px] px-4 text-sm font-medium rounded-lg border ${
              active === s.key ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`}>
            {s.label} <span className="tabular-nums opacity-80" data-testid={`stack-count-${s.key}`}>({board[s.key].length})</span>
          </button>
        ))}
      </div>

      <section data-testid={`stack-${active}`}>
        <p className="text-xs text-muted mb-2">{STACKS.find((s) => s.key === active)!.meaning}</p>
        {/* ── THE HEADER IS THE SORT CONTROL ───────────────────────────────────────────────────
            Three columns only, because these are the three questions a garage asks of a call
            list: which car, whose car, and how soon. The arrow shows the direction on the active
            column and nothing on the others, so the current order is readable without clicking. */}
        {rows.length > 0 && (
          <div className="flex items-center gap-2 px-1 pb-2 mb-1 border-b border-line" data-testid="sort-strip">
            {SORTS.map((c) => (
              <button key={c.key} type="button" onClick={() => sortBy(c.key)}
                data-testid={`sort-${c.key}`} aria-pressed={sortKey === c.key}
                className={`text-xs font-medium px-2 py-1 rounded-lg ${c.width} text-left ${
                  sortKey === c.key ? 'text-ink' : 'text-muted hover:text-ink'}`}>
                {c.label}
                <span className="ml-1 tabular-nums opacity-70" data-testid={`sort-dir-${c.key}`}>
                  {sortKey === c.key ? (desc ? '↓' : '↑') : ''}
                </span>
              </button>
            ))}
          </div>
        )}
        <StackRows rows={rows} empty={STACKS.find((s) => s.key === active)!.empty} onDone={reload} />
      </section>
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
