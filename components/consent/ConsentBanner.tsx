/**
 * File: components/consent/ConsentBanner.tsx
 * The public-site consent banner. First visit: Accept all / Reject all / Manage — Accept and Reject
 * EQUALLY prominent (ICO dark-pattern rules: reject must be no harder than accept). Manage opens
 * per-category toggles with Strictly-necessary locked on. Copy + defaults come from the region config.
 * Shown ONLY on the public marketing site — never a wall in front of the app or Engine Room login.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useConsent } from '@/components/consent/ConsentProvider';
import { getRegionConsentConfig } from '@/lib/consent-config';
import { ALL_ON, ALL_OFF, type ConsentChoice } from '@/lib/consent';

const POLICY_HREF = '/cookies';

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line'} ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
      <span className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

export default function ConsentBanner() {
  const { record, decided, region, setChoice, manageOpen, openManage } = useConsent();
  const cfg = getRegionConsentConfig(region);
  const [managing, setManaging] = useState(false);
  const [choice, setLocal] = useState<ConsentChoice>(record?.choice ?? cfg.defaults);

  useEffect(() => { if (manageOpen) { setManaging(true); setLocal(record?.choice ?? cfg.defaults); } }, [manageOpen, record, cfg.defaults]);

  // Hidden once decided — unless re-opened via the footer "Cookie settings" link (openManage()).
  if (decided && !manageOpen) return null;

  const c = cfg.copy;
  const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover text-white';
  const btnEqual = 'px-4 py-2 rounded-lg text-sm font-medium border border-line bg-surface text-ink hover:bg-surface-muted';
  const btnGhost = 'px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-ink';

  const Row = ({ k, on, locked }: { k: 'necessary' | 'functional' | 'analytics' | 'marketing'; on: boolean; locked?: boolean }) => (
    <div className="flex items-start justify-between gap-4 py-3 border-t border-line">
      <div>
        <div className="text-sm font-medium text-ink">{c[k].label}{locked && <span className="ml-2 text-[11px] text-muted">Always on</span>}</div>
        <div className="text-xs text-muted mt-0.5">{c[k].desc}</div>
      </div>
      <Toggle label={c[k].label} on={on} disabled={locked}
        onChange={locked ? undefined : (v) => setLocal((p) => ({ ...p, [k]: v }))} />
    </div>
  );

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4" role="dialog" aria-label="Cookie choices" aria-modal="false">
      <div className="max-w-3xl mx-auto bg-surface border border-line rounded-2xl shadow-xl p-5">
        <h2 className="text-base font-semibold text-ink">{c.title}</h2>
        <p className="text-sm text-muted mt-1">
          {c.body} <Link href={POLICY_HREF} className="text-accent hover:underline">{c.policyLink}</Link>.
        </p>

        {!managing ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button className={btnPrimary} onClick={() => setChoice(ALL_ON)}>{c.acceptAll}</button>
            <button className={btnEqual} onClick={() => setChoice(ALL_OFF)}>{c.rejectAll}</button>
            <button className={btnGhost} onClick={() => setManaging(true)}>{c.manage}</button>
          </div>
        ) : (
          <div className="mt-3">
            <Row k="necessary" on locked />
            <Row k="functional" on={choice.functional} />
            <Row k="analytics" on={choice.analytics} />
            <Row k="marketing" on={choice.marketing} />
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <button className={btnPrimary} onClick={() => setChoice(choice)}>{c.save}</button>
              <button className={btnEqual} onClick={() => setChoice(ALL_ON)}>{c.acceptAll}</button>
              <button className={btnEqual} onClick={() => setChoice(ALL_OFF)}>{c.rejectAll}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
