/**
 * File: pages/admin/setup.tsx
 * The setup panel + guided walkthrough (item-13). ONE surface for "what's set up", driven entirely by
 * lib/setup-signals (8 signals, three-state, all DERIVED). Two modes on one page:
 *   • panel (default): every signal with its state + a link to its REAL form; the two NA-capable
 *     signals (employees, company number) get an "Not applicable / Applies to me" toggle.
 *   • walk (?walk=1): steps through the OUTSTANDING signals one at a time, sending the owner to each
 *     step's REAL form (no duplicated form — the walkthrough reuses the same form the panel links to,
 *     with ?setup=1 so the form returns here and the sequence advances).
 * No form is re-implemented here. No "done" is stored — it's recomputed from rows on every load.
 */
import { useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import type { GetServerSideProps } from 'next';
import { requireAdminPage } from '@/lib/admin-guard';
import { getSetupSignals, type SetupSignal, type SignalState } from '@/lib/setup-signals';
import { withI18n } from '@/lib/gssp-i18n';

// NOTE: _app auto-wraps every /admin page in AdminLayout — do NOT wrap again here.

type PageProps = { signals: SetupSignal[]; doneCount: number; applicableCount: number };

// Steps whose real form is a modal that must be auto-opened when arriving from the walkthrough.
const NEEDS_ADD = new Set(['employees', 'overheads']);

function walkHref(sig: SetupSignal): string {
  const sep = sig.href.includes('?') ? '&' : '?';
  return `${sig.href}${sep}setup=1${NEEDS_ADD.has(sig.key) ? '&add=1' : ''}`;
}

function StateChip({ state, t }: { state: SignalState; t: (k: string) => string }) {
  const map: Record<SignalState, string> = {
    done: 'bg-ok-soft text-ok border-ok/30',
    todo: 'bg-surface-muted text-muted border-line',
    not_applicable: 'bg-surface-muted text-muted border-line',
  };
  return <span className={`shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5 border ${map[state]}`}>{state === 'done' ? '✓ ' : ''}{t(`state.${state}`)}</span>;
}

export default function SetupPage({ signals, doneCount, applicableCount }: PageProps) {
  const { t } = useTranslation('setup');
  const router = useRouter();
  const walk = router.query.walk === '1';
  const [busyNA, setBusyNA] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const outstanding = useMemo(() => signals.filter((s) => s.state === 'todo'), [signals]);

  async function setNA(signalKey: string, notApplicable: boolean) {
    setBusyNA(signalKey);
    try {
      await fetch('/api/setup/not-applicable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signal: signalKey, notApplicable }) });
      router.replace(router.asPath); // recompute derived signals
    } finally { setBusyNA(null); }
  }

  // ---- WALK MODE ----
  if (walk) {
    const remaining = outstanding.filter((s) => !skipped.has(s.key));
    const current = remaining[0] ?? null;
    const stepNo = outstanding.length - remaining.length + 1;

    if (!current) {
      return (
        <>
          <Head><title>{t('title')} - GreaseDesk</title></Head>
          <div className="max-w-lg mx-auto bg-surface border border-line rounded-2xl p-8 text-center">
            <h1 className="text-xl font-bold text-ink mb-2">{t('walk.finishTitle')}</h1>
            <p className="text-muted mb-6">{t('walk.finishBody')}</p>
            <div className="flex gap-3 justify-center">
              <Link href="/admin/diary" className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium">{t('walk.toDiary')}</Link>
              <Link href="/admin/dashboard" className="border border-line text-ink rounded-lg px-4 py-2.5 text-sm font-medium">{t('walk.toDashboard')}</Link>
            </div>
          </div>
        </>
      );
    }

    return (
      <>
        <Head><title>{t('title')} - GreaseDesk</title></Head>
        <div className="max-w-lg mx-auto">
          <Link href="/admin/setup" className="text-sm text-muted hover:text-ink">← {t('backToPanel')}</Link>
          <div className="bg-surface border border-line rounded-2xl p-8 mt-3">
            <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('walk.stepOf', { n: stepNo, total: outstanding.length })}</p>
            <h1 className="text-xl font-bold text-ink mb-1">{t(`signals.${current.key}.label`)}</h1>
            <p className="text-muted mb-6">{t(`signals.${current.key}.why`)}</p>
            <div className="flex flex-wrap gap-3">
              <Link href={walkHref(current)} className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium">{t('walk.doIt')}</Link>
              {current.canBeNA && (
                <button onClick={() => setNA(current.key, true)} disabled={busyNA === current.key} className="border border-line text-ink rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">{t('markNA')}</button>
              )}
              <button onClick={() => setSkipped((s) => new Set(s).add(current.key))} className="text-muted hover:text-ink rounded-lg px-4 py-2.5 text-sm">{t('walk.skip')}</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ---- PANEL MODE ----
  return (
    <>
      <Head><title>{t('title')} - GreaseDesk</title></Head>
      <div className="max-w-2xl">
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
          <span className="text-sm text-muted">{t('progress', { done: doneCount, total: applicableCount })}</span>
        </div>
        <p className="text-muted mb-5">{t('subtitle')}</p>

        {outstanding.length > 0 ? (
          <Link href="/admin/setup?walk=1" className="inline-block mb-5 bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium">{t('startWalk')}</Link>
        ) : (
          <div className="mb-5 bg-ok-soft border border-ok/30 text-ok rounded-xl px-4 py-3 text-sm font-medium">{t('allDoneTitle')} — {t('allDoneBody')}</div>
        )}

        <ul className="space-y-2">
          {signals.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-3 bg-surface rounded-xl border border-line px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-ink font-medium">{t(`signals.${s.key}.label`)}</span>
                  <StateChip state={s.state} t={t} />
                </div>
                <p className="text-xs text-muted truncate">{t(`signals.${s.key}.why`)}</p>
              </div>
              <div className="shrink-0 flex items-center gap-3">
                {s.canBeNA && s.state === 'todo' && (
                  <button onClick={() => setNA(s.key, true)} disabled={busyNA === s.key} className="text-xs text-muted hover:text-ink disabled:opacity-50">{t('markNA')}</button>
                )}
                {s.canBeNA && s.state === 'not_applicable' && (
                  <button onClick={() => setNA(s.key, false)} disabled={busyNA === s.key} className="text-xs text-accent hover:underline disabled:opacity-50">{t('markApplicable')}</button>
                )}
                {s.state !== 'not_applicable' && (
                  <Link href={s.href} className="text-sm font-medium text-accent hover:underline whitespace-nowrap">{s.state === 'done' ? t('edit') : t('setUp')} →</Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['setup'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;
  const summary = await getSetupSignals(vis.groupId as string, vis.primarySiteId);
  return { props: { signals: summary.signals, doneCount: summary.doneCount, applicableCount: summary.applicableCount } };
});
