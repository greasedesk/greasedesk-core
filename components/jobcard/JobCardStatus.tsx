/**
 * File: components/jobcard/JobCardStatus.tsx
 * Status lifecycle + the four operational stage toggles for a job card. Reads the state machine
 * (lib/jobcard-status.ts) to offer only valid+permitted next-transitions; the API re-enforces.
 * Light theme/tokens, i18n-native (jobcard namespace), mobile-first (full-width tap targets).
 */
import React, { useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { JobStatus, StageKey, STAGE_KEYS, nextTransitions } from '@/lib/jobcard-status';

type Stages = Record<StageKey, boolean>;

type Props = {
  jobCardId: string;
  status: JobStatus;
  stages: Stages;
  hasEstimate: boolean;
  canManage: boolean;   // commercial authority (manager/admin)
  canOperate: boolean;  // operational authority (any site-assigned user)
};

const STATUS_TONE: Record<JobStatus, string> = {
  draft: 'bg-surface-muted text-muted',
  quoted: 'bg-surface-muted text-ink',
  accepted: 'bg-accent-soft text-accent',
  in_progress: 'bg-accent-soft text-accent',
  invoiced: 'bg-ok-soft text-ok',
  paid: 'bg-ok-soft text-ok',
  done: 'bg-ok-soft text-ok',
  declined: 'bg-danger-soft text-danger',
  cancelled: 'bg-danger-soft text-danger',
};

export default function JobCardStatus({ jobCardId, status, stages, hasEstimate, canManage, canOperate }: Props) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const allStagesDone = STAGE_KEYS.every((k) => stages[k]);

  async function go(url: string, body: any, errKey: string) {
    setBusy(JSON.stringify(body)); setErr(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.message || t(errKey)); setBusy(null); return; }
      router.replace(router.asPath);
    } catch {
      setErr(t(errKey)); setBusy(null);
    }
  }

  // Only transitions this user is permitted to perform; gated-but-unmet ones render disabled + reason.
  const transitions = nextTransitions(status)
    .filter((tr) => (tr.kind === 'operational' ? canOperate : canManage))
    .map((tr) => {
      let gateOk = true;
      let reason: string | null = null;
      if (tr.gate === 'estimate_exists' && !hasEstimate) { gateOk = false; reason = t('estimate.emptyParts'); }
      if (tr.gate === 'all_stages_done' && !allStagesDone) { gateOk = false; reason = t('stage.hint'); }
      return { tr, gateOk, reason };
    });

  return (
    <div className="bg-surface border border-line rounded-xl p-5 mb-5">
      {/* Status pill + transition actions */}
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <span className="text-xs uppercase text-muted">{t('status.label')}</span>
        <span className={`text-sm font-medium px-3 py-1 rounded-full ${STATUS_TONE[status]}`}>{t(`status.${status}`)}</span>
      </div>
      {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}

      {transitions.length > 0 && (
        <div className="flex flex-col sm:flex-row flex-wrap gap-2 mt-2">
          {transitions.map(({ tr, gateOk, reason }) => {
            const isCancel = tr.to === 'cancelled';
            const base = 'text-sm font-semibold rounded-lg px-4 py-2.5 w-full sm:w-auto disabled:opacity-50';
            const tone = isCancel ? 'bg-danger-soft text-danger' : 'bg-accent hover:bg-accent-hover text-white';
            return (
              <button
                key={tr.to}
                onClick={() => go('/api/jobcard-status', { jobCardId, to: tr.to }, 'action.error')}
                disabled={!gateOk || busy !== null}
                title={!gateOk ? reason ?? undefined : undefined}
                className={`${base} ${tone}`}
              >
                {busy ? t('action.working') : t(`action.${tr.to}`)}
              </button>
            );
          })}
        </div>
      )}

      {/* Four operational stage toggles */}
      <div className="border-t border-line mt-4 pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-ink">{t('stage.title')}</span>
        </div>
        <p className="text-xs text-muted mb-3">{t('stage.hint')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {STAGE_KEYS.map((k) => (
            <label
              key={k}
              className={`flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-3 ${stages[k] ? 'bg-ok-soft' : 'bg-surface-muted'} ${canOperate ? 'cursor-pointer' : 'opacity-70'}`}
            >
              <span className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="w-5 h-5 accent-[color:var(--accent)]"
                  checked={stages[k]}
                  disabled={!canOperate || busy !== null}
                  onChange={(e) => go('/api/jobcard-stage', { jobCardId, stage: k, done: e.target.checked }, 'stage.error')}
                />
                {t(`stage.${k}`)}
              </span>
              <span className={`text-xs ${stages[k] ? 'text-ok' : 'text-muted'}`}>{stages[k] ? t('stage.done') : t('stage.pending')}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
