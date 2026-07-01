/**
 * File: pages/admin/diary.tsx
 * Detail-rich diary (light theme). Source of truth = JobCard.start_at/end_at. Jobs render as blocks
 * laid out in overlap sub-columns (lib/diary-layout); week shows the site's OPEN days and narrows.
 * Two-way seam: single-click block = peek, double-click = open card; and CREATE on empty space —
 * click (1h) or drag (range, 15-min snap) opens a dialogue to add a job card (scheduled) or a note.
 * DiaryNotes render visually distinct from jobs. Create/place is manager/admin (canManageSite).
 */
import React, { useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';
import { resolveColour, blockTint, RESOURCE_PALETTE } from '@/lib/diary-colours';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { layoutOverlap } from '@/lib/diary-layout';
import { formatMoney } from '@/lib/format-money';
import { computeQuoteTotals, poundsToPennies } from '@/lib/quote-totals';

const PX_PER_MIN = 1;

type ResourceCol = { id: string; name: string; type: string; colour: string | null };
type DiaryCard = { id: string; resourceId: string; resourceName: string; resourceColour: string | null; reg: string; customer: string; startAt: string; endAt: string; status: string; valuePennies: number };
type DiaryNoteView = { id: string; title: string; resourceId: string | null; colour: string | null; startAt: string; endAt: string };
type DayCol = { date: string; label: string };
type PageProps = {
  siteId: string; siteName: string; view: 'week' | 'day'; anchor: string;
  prev: string; next: string; days: DayCol[];
  resources: ResourceCol[]; cards: DiaryCard[]; notes: DiaryNoteView[];
  openHour: number; closeHour: number; currency: string; locale: string; canManage: boolean;
  noSites?: boolean;
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function dayStartMs(date: string) { return Date.parse(`${date}T00:00:00.000Z`); }
function hhmm(iso: string) { return new Date(iso).toISOString().slice(11, 16); }
const pad = (n: number) => String(n).padStart(2, '0');
const snap15 = (min: number) => Math.round(min / 15) * 15;

export default function DiaryPage(props: PageProps) {
  const { siteId, siteName, view, anchor, prev, next, days, resources, cards, notes, openHour, closeHour, currency, locale, canManage, noSites } = props;
  const { t } = useTranslation('diary');
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  const WIN_MIN = (closeHour - openHour) * 60;
  const HOURS = Array.from({ length: closeHour - openHour + 1 }, (_, i) => openHour + i);

  const [peek, setPeek] = useState<{ card: DiaryCard; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ colKey: string; date: string; resourceId?: string; aY: number; bY: number } | null>(null);
  const [create, setCreate] = useState<{ date: string; startAt: string; endAt: string; resourceId?: string } | null>(null);
  const [editNote, setEditNote] = useState<DiaryNoteView | null>(null);
  const clickTimer = useRef<number | null>(null);

  if (noSites) {
    return (
      <AdminLayout>
        <Head><title>{t('title')} - GreaseDesk</title></Head>
        <div className="bg-surface text-ink rounded-xl border border-line p-8 text-center shadow">{t('noSite')}</div>
      </AdminLayout>
    );
  }

  function segment(c: { startAt: string; endAt: string }, d: string) {
    const winStart = dayStartMs(d) + openHour * 3600000;
    const winEnd = dayStartMs(d) + closeHour * 3600000;
    const s = Math.max(Date.parse(c.startAt), winStart);
    const e = Math.min(Date.parse(c.endAt), winEnd);
    if (e <= s) return null;
    return { top: ((s - winStart) / 60000) * PX_PER_MIN, height: Math.max(18, ((e - s) / 60000) * PX_PER_MIN), s, e };
  }
  const minToISO = (date: string, min: number) => `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00.000Z`;

  function openCard(id: string) { router.push(`/admin/jobcards/${id}`); }
  function onBlockClick(card: DiaryCard, e: React.MouseEvent) {
    e.stopPropagation();
    const x = e.clientX, y = e.clientY;
    if (clickTimer.current) return;
    clickTimer.current = window.setTimeout(() => { clickTimer.current = null; setPeek({ card, x, y }); }, 200);
  }
  function onBlockDbl(card: DiaryCard, e: React.MouseEvent) {
    e.stopPropagation();
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    setPeek(null); openCard(card.id);
  }

  // ---- empty-space create gesture (manager only) ----
  function colYFromEvent(e: React.PointerEvent) { return e.clientY - e.currentTarget.getBoundingClientRect().top; }
  function onColDown(col: { key: string; date: string; resourceId?: string }, e: React.PointerEvent) {
    if (!canManage) return;
    (e.currentTarget as any).setPointerCapture?.(e.pointerId);
    const y = colYFromEvent(e);
    setDrag({ colKey: col.key, date: col.date, resourceId: col.resourceId, aY: y, bY: y });
  }
  function onColMove(e: React.PointerEvent) { if (drag) setDrag({ ...drag, bY: colYFromEvent(e) }); }
  function onColUp(e: React.PointerEvent) {
    if (!drag) return;
    const a = Math.min(drag.aY, drag.bY), b = Math.max(drag.aY, drag.bY);
    const single = b - a < 6;
    let sMin = snap15(openHour * 60 + Math.round(single ? drag.aY : a));
    let eMin = snap15(single ? sMin + 60 : openHour * 60 + Math.round(b));
    sMin = Math.max(openHour * 60, Math.min(sMin, closeHour * 60 - 15));
    eMin = Math.min(closeHour * 60, Math.max(eMin, sMin + 15));
    setCreate({ date: drag.date, resourceId: drag.resourceId, startAt: minToISO(drag.date, sMin), endAt: minToISO(drag.date, eMin) });
    setDrag(null);
  }

  const columns = view === 'week'
    ? days.map((d) => ({ key: d.date, label: d.label, date: d.date, resourceId: undefined as string | undefined }))
    : resources.map((r) => ({ key: r.id, label: r.name, date: anchor, resourceId: r.id }));

  // Day-level notes (no lift) shown as a banner strip in day view.
  const dayLevelNotes = view === 'day' ? notes.filter((n) => !n.resourceId && segment(n, anchor)) : [];

  type Item = { s: number; e: number; top: number; height: number; kind: 'job'; card: DiaryCard } | { s: number; e: number; top: number; height: number; kind: 'note'; note: DiaryNoteView };

  function JobBlock({ c, top, height, leftPct, widthPct }: { c: DiaryCard; top: number; height: number; leftPct: number; widthPct: number }) {
    const colour = resolveColour(c.resourceColour);
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => onBlockClick(c, e)}
        onDoubleClick={(e) => onBlockDbl(c, e)}
        style={{ top, height, left: `${leftPct}%`, width: `calc(${widthPct}% - 3px)`, backgroundColor: blockTint(colour), borderLeft: `3px solid ${colour}` }}
        className="diary-block absolute rounded-md overflow-hidden shadow-sm cursor-pointer select-none"
        title={`${c.reg} · ${c.customer} · ${c.resourceName} · ${hhmm(c.startAt)}–${hhmm(c.endAt)}`}
      >
        <span className="diary-reg block font-semibold text-[11px] text-ink px-1 pt-0.5">{c.reg}</span>
        {view === 'day' && height > 40 && <span className="block text-[10px] text-muted px-1 truncate">{c.customer}</span>}
      </div>
    );
  }
  function NoteBlock({ n, top, height, leftPct, widthPct }: { n: DiaryNoteView; top: number; height: number; leftPct: number; widthPct: number }) {
    const colour = n.colour || '#94a3b8';
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); if (canManage) setEditNote(n); }}
        style={{ top, height, left: `${leftPct}%`, width: `calc(${widthPct}% - 3px)`, borderColor: colour, cursor: canManage ? 'pointer' : 'default' }}
        className="diary-block absolute rounded-md overflow-hidden bg-surface-muted border-2 border-dashed select-none"
        title={`${t('note.tag')}: ${n.title} · ${hhmm(n.startAt)}–${hhmm(n.endAt)}`}
      >
        <span className="block text-[9px] uppercase tracking-wide text-muted px-1 pt-0.5">{t('note.tag')}</span>
        <span className="diary-reg block text-[11px] italic text-ink px-1">{n.title}</span>
      </div>
    );
  }

  return (
    <AdminLayout>
      <Head><title>{t('title')} - GreaseDesk</title></Head>

      <div className="bg-surface text-ink rounded-xl border border-line p-4 shadow">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-bold text-ink">{t('title')} — {siteName}</h1>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-line">
              <Link href={`/admin/diary?site=${siteId}&view=week&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'week' ? 'bg-accent text-white' : 'bg-surface-muted text-ink'}`}>{t('week')}</Link>
              <Link href={`/admin/diary?site=${siteId}&view=day&date=${anchor}`} className={`px-3 py-1.5 text-sm ${view === 'day' ? 'bg-accent text-white' : 'bg-surface-muted text-ink'}`}>{t('day')}</Link>
            </div>
            <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${prev}`} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">←</Link>
            <span className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">{view === 'week' ? t('weekOf', { date: days[0]?.date ?? anchor }) : anchor}</span>
            <Link href={`/admin/diary?site=${siteId}&view=${view}&date=${next}`} className="px-3 py-1.5 bg-surface-muted border border-line rounded-lg text-sm text-ink">→</Link>
          </div>
        </div>

        {resources.length === 0 ? (
          <div className="bg-surface-muted border border-line rounded-xl p-8 text-center text-muted">{t('noResources')}</div>
        ) : (
          <>
            {/* Day-level notes banner (day view) */}
            {dayLevelNotes.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                <span className="text-xs uppercase text-muted self-center">{t('note.dayNotes')}:</span>
                {dayLevelNotes.map((n) => (
                  <span key={n.id} onDoubleClick={() => { if (canManage) setEditNote(n); }}
                    style={{ borderColor: n.colour || '#94a3b8', cursor: canManage ? 'pointer' : 'default' }}
                    className="text-xs px-2 py-1 rounded-md bg-surface-muted border-2 border-dashed">
                    <span className="italic text-ink">{n.title}</span> <span className="text-muted">{hhmm(n.startAt)}–{hhmm(n.endAt)}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="overflow-x-auto">
              <div className="flex min-w-full">
                <div className="w-14 shrink-0 pt-7">
                  {HOURS.map((h) => (
                    <div key={h} style={{ height: 60 * PX_PER_MIN }} className="text-xs text-muted text-right pr-2 -mt-2">{pad(h)}:00</div>
                  ))}
                </div>
                <div className="flex-1 flex min-w-0">
                  {columns.map((col) => {
                    // Jobs + lift/day notes for this column → unified overlap layout.
                    const items: Item[] = [];
                    for (const c of cards) {
                      if (view === 'day' && c.resourceId !== col.resourceId) continue;
                      const sg = segment(c, col.date); if (!sg) continue;
                      items.push({ s: sg.s, e: sg.e, top: sg.top, height: sg.height, kind: 'job', card: c });
                    }
                    for (const n of notes) {
                      if (view === 'day') { if (n.resourceId !== col.resourceId) continue; } // day-level handled by banner
                      const sg = segment(n, col.date); if (!sg) continue;
                      items.push({ s: sg.s, e: sg.e, top: sg.top, height: sg.height, kind: 'note', note: n });
                    }
                    const placed = layoutOverlap(items);
                    return (
                      <div key={col.key} className="flex-1 min-w-[46px] border-l border-line">
                        <div className="h-7 text-sm text-ink text-center font-medium truncate px-1">{col.label}</div>
                        <div
                          className="relative bg-surface"
                          style={{ height: WIN_MIN * PX_PER_MIN, touchAction: canManage ? 'none' : undefined, cursor: canManage ? 'crosshair' : undefined }}
                          onPointerDown={(e) => onColDown(col, e)}
                          onPointerMove={onColMove}
                          onPointerUp={onColUp}
                        >
                          {HOURS.slice(1).map((h, i) => (
                            <div key={h} style={{ top: (i + 1) * 60 * PX_PER_MIN }} className="absolute left-0 right-0 border-t border-line" />
                          ))}
                          {drag && drag.colKey === col.key && (
                            <div className="absolute left-0 right-0 bg-accent-soft border border-accent rounded pointer-events-none" style={{ top: Math.min(drag.aY, drag.bY), height: Math.max(8, Math.abs(drag.bY - drag.aY)) }} />
                          )}
                          {placed.map((x) => x.kind === 'job'
                            ? <JobBlock key={x.card.id} c={x.card} top={x.top} height={x.height} leftPct={(x.col / x.cols) * 100} widthPct={100 / x.cols} />
                            : <NoteBlock key={x.note.id} n={x.note} top={x.top} height={x.height} leftPct={(x.col / x.cols) * 100} widthPct={100 / x.cols} />)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {canManage && <p className="text-xs text-muted mt-2">{t('create.title')}: click or drag an empty slot.</p>}
          </>
        )}
      </div>

      {/* Peek popover */}
      {peek && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPeek(null)} />
          <div className="fixed z-50 bg-surface border border-line rounded-xl shadow-lg p-3 w-64 text-sm"
            style={{ left: Math.min(peek.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 272), top: Math.min(peek.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200) }}>
            <div className="font-semibold text-ink text-base mb-1">{peek.card.reg}</div>
            <div className="space-y-0.5">
              <div><span className="text-muted">{t('peek.customer')}: </span><span className="text-ink">{peek.card.customer}</span></div>
              <div><span className="text-muted">{t('peek.lift')}: </span><span className="text-ink">{peek.card.resourceName}</span></div>
              <div><span className="text-muted">{t('peek.time')}: </span><span className="text-ink">{hhmm(peek.card.startAt)}–{hhmm(peek.card.endAt)}</span></div>
              <div><span className="text-muted">{t('peek.status')}: </span><span className="text-ink">{t(`status.${peek.card.status}`)}</span></div>
              <div><span className="text-muted">{t('peek.value')}: </span><span className="text-ink font-medium">{formatMoney(peek.card.valuePennies, { currency, locale })}</span></div>
            </div>
            <Link href={`/admin/jobcards/${peek.card.id}`} className="mt-2 inline-block text-accent hover:underline font-medium">{t('peek.open')} →</Link>
          </div>
        </>
      )}

      {create && (
        <CreateDialog
          info={create} siteId={siteId} resources={resources} defaultResourceId={create.resourceId ?? null}
          onClose={() => setCreate(null)} onDone={() => { setCreate(null); refresh(); }}
        />
      )}

      {editNote && (
        <EditNoteDialog
          note={editNote} resources={resources}
          onClose={() => setEditNote(null)} onDone={() => { setEditNote(null); refresh(); }}
        />
      )}
    </AdminLayout>
  );
}

// ---- create dialogue (module scope so inputs don't remount on keystroke) ----
function CreateDialog({ info, siteId, resources, defaultResourceId, onClose, onDone }: {
  info: { date: string; startAt: string; endAt: string; resourceId?: string };
  siteId: string; resources: ResourceCol[]; defaultResourceId: string | null;
  onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation('diary');
  const [mode, setMode] = useState<'choose' | 'job' | 'note'>('choose');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // job fields
  const [reg, setReg] = useState(''); const [cust, setCust] = useState(''); const [mileage, setMileage] = useState('');
  const [liftId, setLiftId] = useState(defaultResourceId ?? resources[0]?.id ?? '');
  // note fields
  const [title, setTitle] = useState(''); const [noteLift, setNoteLift] = useState(defaultResourceId ?? ''); const [colour, setColour] = useState('');
  const when = `${info.date} · ${info.startAt.slice(11, 16)}–${info.endAt.slice(11, 16)}`;

  async function createJob() {
    if (!reg.trim() || !cust.trim() || !liftId) { setErr(t('create.jobFailed')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/jobcard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registration: reg, customerName: cust, mileage: mileage || undefined, siteId, resourceId: liftId, startAt: info.startAt, endAt: info.endAt }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('create.jobFailed')); return; }
    onDone();
  }
  async function addNote() {
    if (!title.trim()) { setErr(t('create.noteFailed')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/diary-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, title, startAt: info.startAt, endAt: info.endAt, resourceId: noteLift || null, colour: colour || null }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('create.noteFailed')); return; }
    onDone();
  }

  const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
  const labelCls = 'block text-xs text-muted mb-1';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-line shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink">{t('create.title')}</h2>
        <p className="text-sm text-muted mb-4">{when}</p>
        {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}

        {mode === 'choose' && (
          <div className="flex flex-col sm:flex-row gap-3">
            <button onClick={() => setMode('job')} className="flex-1 bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-3 text-sm">{t('create.chooseJob')}</button>
            <button onClick={() => setMode('note')} className="flex-1 bg-surface-muted border border-line text-ink font-semibold rounded-lg px-4 py-3 text-sm">{t('create.chooseNote')}</button>
          </div>
        )}

        {mode === 'job' && (
          <div className="space-y-3">
            <div><label className={labelCls}>{t('create.reg')}</label><input className={inputCls} value={reg} onChange={(e) => setReg(e.target.value)} /></div>
            <div><label className={labelCls}>{t('create.customer')}</label><input className={inputCls} value={cust} onChange={(e) => setCust(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>{t('create.mileage')}</label><input className={inputCls} type="number" value={mileage} onChange={(e) => setMileage(e.target.value)} /></div>
              <div><label className={labelCls}>{t('create.lift')}</label>
                <select className={inputCls} value={liftId} onChange={(e) => setLiftId(e.target.value)}>
                  {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={createJob} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('create.working') : t('create.createJob')}</button>
              <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
            </div>
          </div>
        )}

        {mode === 'note' && (
          <div className="space-y-3">
            <div><label className={labelCls}>{t('create.noteTitle')}</label><input className={inputCls} placeholder={t('create.notePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div><label className={labelCls}>{t('create.lift')}</label>
              <select className={inputCls} value={noteLift} onChange={(e) => setNoteLift(e.target.value)}>
                <option value="">{t('create.dayLevel')}</option>
                {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('create.colour')}</label>
              <div className="flex flex-wrap gap-2">
                {/* "None" — no colour */}
                <button
                  type="button" onClick={() => setColour('')}
                  aria-label={t('create.noColour')} title={t('create.noColour')} aria-pressed={colour === ''}
                  className={`w-8 h-8 rounded-full bg-surface flex items-center justify-center ${colour === '' ? 'ring-2 ring-accent ring-offset-1 border border-line' : 'border border-line'}`}
                >
                  <span className="text-muted text-xs leading-none">✕</span>
                </button>
                {RESOURCE_PALETTE.map((c) => (
                  <button
                    key={c} type="button" onClick={() => setColour(c)}
                    aria-label={c} title={c} aria-pressed={colour === c}
                    style={{ backgroundColor: c }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${colour === c ? 'ring-2 ring-accent ring-offset-1' : 'border border-line'}`}
                  >
                    {colour === c && <span className="text-white text-sm leading-none">✓</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={addNote} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('create.working') : t('create.addNote')}</button>
              <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- edit / delete a note (module scope so inputs don't remount) ----
function EditNoteDialog({ note, resources, onClose, onDone }: {
  note: DiaryNoteView; resources: ResourceCol[]; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation('diary');
  const dPart = (iso: string) => iso.slice(0, 10);
  const tPart = (iso: string) => iso.slice(11, 16);
  const [title, setTitle] = useState(note.title);
  const [startDate, setStartDate] = useState(dPart(note.startAt));
  const [startTime, setStartTime] = useState(tPart(note.startAt));
  const [endDate, setEndDate] = useState(dPart(note.endAt));
  const [endTime, setEndTime] = useState(tPart(note.endAt));
  const [noteLift, setNoteLift] = useState(note.resourceId ?? '');
  const [colour, setColour] = useState(note.colour ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
  const labelCls = 'block text-xs text-muted mb-1';

  async function save() {
    if (!title.trim()) { setErr(t('editNote.saveError')); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/diary-notes', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note.id, title, startAt: `${startDate}T${startTime}:00.000Z`, endAt: `${endDate}T${endTime}:00.000Z`, resourceId: noteLift || null, colour: colour || null }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('editNote.saveError')); return; }
    onDone();
  }
  async function del() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/diary-notes?id=${note.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data?.message || t('editNote.deleteError')); return; }
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-line shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink mb-4">{t('editNote.title')}</h2>
        {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}
        <div className="space-y-3">
          <div><label className={labelCls}>{t('create.noteTitle')}</label><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className={labelCls}>{t('create.start')}</label>
              <div className="flex gap-2"><input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} /><input type="time" className={inputCls} value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
            </div>
            <div><label className={labelCls}>{t('create.end')}</label>
              <div className="flex gap-2"><input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} /><input type="time" className={inputCls} value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
            </div>
          </div>
          <div><label className={labelCls}>{t('create.lift')}</label>
            <select className={inputCls} value={noteLift} onChange={(e) => setNoteLift(e.target.value)}>
              <option value="">{t('create.dayLevel')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('create.colour')}</label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setColour('')} aria-label={t('create.noColour')} title={t('create.noColour')} aria-pressed={colour === ''}
                className={`w-8 h-8 rounded-full bg-surface flex items-center justify-center ${colour === '' ? 'ring-2 ring-accent ring-offset-1 border border-line' : 'border border-line'}`}>
                <span className="text-muted text-xs leading-none">✕</span>
              </button>
              {RESOURCE_PALETTE.map((c) => (
                <button key={c} type="button" onClick={() => setColour(c)} aria-label={c} title={c} aria-pressed={colour === c} style={{ backgroundColor: c }}
                  className={`w-8 h-8 rounded-full flex items-center justify-center ${colour === c ? 'ring-2 ring-accent ring-offset-1' : 'border border-line'}`}>
                  {colour === c && <span className="text-white text-sm leading-none">✓</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <button onClick={save} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">{busy ? t('editNote.saving') : t('editNote.save')}</button>
              <button onClick={onClose} className="text-muted hover:text-ink px-3 text-sm">{t('create.cancel')}</button>
            </div>
            {confirmDel ? (
              <button onClick={del} disabled={busy} className="bg-danger text-white font-semibold rounded-lg px-3 py-2.5 text-sm disabled:opacity-50">{t('editNote.confirmYes')}</button>
            ) : (
              <button onClick={() => setConfirmDel(true)} className="text-danger hover:underline text-sm">{t('editNote.delete')}</button>
            )}
          </div>
          {confirmDel && <p className="text-xs text-danger text-right">{t('editNote.confirmDelete')}</p>}
        </div>
      </div>
    </div>
  );
}

export const getServerSideProps = withI18n(['diary'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };

  const vis = await getVisibility(user.id as string);
  if (vis.siteIds.length === 0) {
    const today = ymd(new Date());
    return { props: { siteId: '', siteName: '', view: 'week', anchor: today, prev: today, next: today, days: [], resources: [], cards: [], notes: [], openHour: 8, closeHour: 18, currency: 'GBP', locale: 'en-GB', canManage: false, noSites: true } };
  }

  const wanted = (ctx.query.site as string) || user.site_id;
  const resolvedId = wanted && vis.siteIds.includes(wanted) ? wanted : vis.siteIds[0];
  const site = (await prisma.site.findFirst({
    where: { id: resolvedId },
    select: { id: true, site_name: true, open_days: true, open_hour: true, close_hour: true, week_start: true, currency_code: true, locale: true },
  })) as any;
  if (!site) return { redirect: { destination: '/admin/diary', permanent: false } };

  const openDays: number[] = (site.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6]).slice().sort((a: number, b: number) => a - b);
  const openHour: number = site.open_hour ?? 8;
  const closeHour: number = site.close_hour ?? 18;
  const weekStart: number = site.week_start ?? 1;
  const canManage = canManageSite(vis, site.id);

  const view: 'week' | 'day' = ctx.query.view === 'day' ? 'day' : 'week';
  const dateParam = (ctx.query.date as string) || '';
  const anchorObj = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00.000Z`) : new Date(`${ymd(new Date())}T00:00:00.000Z`);
  const anchor = ymd(anchorObj);
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let rangeStart: Date, rangeEnd: Date, days: DayCol[], prev: string, next: string;
  if (view === 'week') {
    const dow = anchorObj.getUTCDay();
    const offset = (dow - weekStart + 7) % 7;
    const weekStartObj = new Date(anchorObj.getTime() - offset * 86400000);
    rangeStart = weekStartObj;
    rangeEnd = new Date(weekStartObj.getTime() + 7 * 86400000);
    days = Array.from({ length: 7 }, (_, i) => new Date(weekStartObj.getTime() + i * 86400000))
      .filter((d) => openDays.includes(d.getUTCDay()))
      .map((d) => ({ date: ymd(d), label: `${DAY_LABELS[d.getUTCDay()]} ${d.getUTCDate()}` }));
    prev = ymd(new Date(anchorObj.getTime() - 7 * 86400000));
    next = ymd(new Date(anchorObj.getTime() + 7 * 86400000));
  } else {
    rangeStart = anchorObj;
    rangeEnd = new Date(anchorObj.getTime() + 86400000);
    days = [{ date: anchor, label: anchor }];
    prev = ymd(new Date(anchorObj.getTime() - 86400000));
    next = ymd(new Date(anchorObj.getTime() + 86400000));
  }

  type ResRow = { id: string; name: string; type: string; colour: string | null };
  const [resourceRows, cardRows, noteRows] = await Promise.all([
    prisma.resource.findMany({ where: { site_id: site.id, is_active: true }, orderBy: { display_order: 'asc' }, select: { id: true, name: true, type: true, colour: true } }) as Promise<ResRow[]>,
    prisma.jobCard.findMany({
      where: { site_id: site.id, resource_id: { not: null }, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: {
        id: true, resource_id: true, start_at: true, end_at: true, status: true, vat_rate: true,
        resource: { select: { name: true, colour: true } }, vehicle: { select: { registration: true } }, customer: { select: { name: true } },
        items: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true } },
      },
    }) as Promise<any[]>,
    prisma.diaryNote.findMany({
      where: { site_id: site.id, start_at: { lt: rangeEnd }, end_at: { gt: rangeStart } },
      select: { id: true, title: true, resource_id: true, colour: true, start_at: true, end_at: true },
    }) as Promise<any[]>,
  ]);

  const resources: ResourceCol[] = resourceRows.map((r) => ({ id: r.id, name: r.name, type: r.type, colour: r.colour }));
  const num = (d: any) => (d == null ? 0 : Number(d));
  const cards: DiaryCard[] = cardRows.map((c) => {
    const totals = computeQuoteTotals(
      (c.items as any[]).map((it) => ({ item_type: it.item_type, qty: num(it.qty), unit_price_pennies: poundsToPennies(num(it.unit_price)), unit_cost_pennies: poundsToPennies(num(it.unit_cost)), vatable: num(it.vat_rate) > 0 })),
      num(c.vat_rate),
    );
    return {
      id: c.id, resourceId: c.resource_id as string, resourceName: c.resource?.name ?? '—', resourceColour: c.resource?.colour ?? null,
      reg: c.vehicle?.registration ?? '—', customer: c.customer?.name ?? '—',
      startAt: (c.start_at as Date).toISOString(), endAt: (c.end_at as Date).toISOString(),
      status: c.status as string, valuePennies: totals.total_pennies,
    };
  });
  const notes: DiaryNoteView[] = noteRows.map((n) => ({ id: n.id, title: n.title, resourceId: n.resource_id ?? null, colour: n.colour ?? null, startAt: (n.start_at as Date).toISOString(), endAt: (n.end_at as Date).toISOString() }));

  return { props: { siteId: site.id, siteName: site.site_name, view, anchor, prev, next, days, resources, cards, notes, openHour, closeHour, currency: site.currency_code ?? 'GBP', locale: site.locale ?? 'en-GB', canManage } };
});
