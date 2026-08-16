/**
 * File: components/consent/ConsentBanner.tsx
 * The public-site consent banner. First visit: Accept all / Reject all / Manage — Accept and Reject
 * EQUALLY prominent (ICO dark-pattern rules: reject must be no harder than accept). Manage opens
 * per-category toggles with Strictly-necessary locked on. Copy + defaults come from the region config.
 * Shown ONLY on the public marketing site — never a wall in front of the app or Engine Room login.
 *
 * ── A BAR THAT COVERS THE BUTTON UNDER IT IS A BAR THAT BREAKS THE PAGE ─────────────────────────
 * This used to be a tall card pinned to the bottom: 216px on desktop, 268px on a phone, and 724px —
 * 89% OF THE SCREEN — once the categories were expanded in place. It is a fixed overlay, so all of
 * that sat on top of whatever the page had at the bottom. On the customer invoice page that is the
 * Pay button, and a customer following a pay link physically could not press it. The same overlap
 * covered the submit buttons on register, contact and the password pages.
 *
 * Two changes, and they work together:
 *   1. THE RESTING STATE IS A STRIP. One line: a sentence, the policy link, and the three choices.
 *      The categories now open as a CENTRED MODAL instead of growing the bar, which is what turned
 *      a 268px bar into a 724px one on a phone.
 *   2. THE STRIP PUBLISHES ITS OWN HEIGHT as `--consent-height`, and body reserves it (globals.css),
 *      so nothing is ever underneath. MEASURED, not hardcoded: the height moves with the viewport,
 *      the region's copy and the reader's text size, and a constant would be right on a laptop and
 *      wrong on a phone in Welsh.
 *
 * The MODAL is deliberately not measured and not reserved for. It is transient and the reader opened
 * it on purpose — covering the page for as long as it takes to choose is what a modal is for. The
 * passive, un-asked-for state is the one that must never cover anything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

  // ── THE STRIP MEASURES ITSELF ────────────────────────────────────────────────────────────────
  // A ResizeObserver rather than a one-off read: the height changes when the viewport rotates, when
  // the copy reflows, and when the reader has a larger text size set. Published on the root element
  // so globals.css can reserve it without any page knowing this component exists.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const publish = useCallback((px: number) => {
    document.documentElement.style.setProperty('--consent-height', `${Math.ceil(px)}px`);
  }, []);

  const hidden = decided && !manageOpen;

  useEffect(() => {
    // ALWAYS clears on the way out. Leaving the variable set after a choice would reserve a strip of
    // dead space at the bottom of every public page for the rest of the session.
    if (hidden) { document.documentElement.style.setProperty('--consent-height', '0px'); return; }
    const el = stripRef.current;
    if (!el) return;
    publish(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => { for (const e of entries) publish(e.contentRect.height); });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.setProperty('--consent-height', '0px');
    };
  }, [hidden, publish]);

  // Hidden once decided — unless re-opened via the footer "Cookie settings" link (openManage()).
  if (hidden) return null;

  const c = cfg.copy;
  // Compact on a phone, comfortable from `sm` up. The three must stay the same SIZE as each other
  // at every breakpoint — only the fill differs — or "reject is no harder than accept" stops being
  // true at exactly the width where it matters most.
  const btnBase = 'px-3 py-1.5 text-xs sm:px-4 sm:py-2 sm:text-sm rounded-lg font-medium whitespace-nowrap';
  const btnPrimary = `${btnBase} bg-accent hover:bg-accent-hover text-white`;
  const btnEqual = `${btnBase} border border-line bg-surface text-ink hover:bg-surface-muted`;
  const btnGhost = `${btnBase} text-muted hover:text-ink`;

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
    <>
      {/* ── THE RESTING STRIP ─────────────────────────────────────────────────────────────────
          Edge to edge and square rather than a floating rounded card: a full-width rule reads as
          part of the page furniture at this height, where an inset card reads as a cropped dialog.
          The measured element is THIS one — the modal below is outside it deliberately. */}
      <div ref={stripRef} data-testid="consent-banner"
        className="fixed inset-x-0 bottom-0 z-50 bg-surface border-t border-line shadow-lg"
        role="region" aria-label="Cookie choices">
        <div className="max-w-5xl mx-auto px-4 py-2 sm:py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
          {/* TWO ROWS ON A PHONE, one from `sm` up. A genuine single line at 375px would mean
              truncating this sentence, and the first casualty of a truncated sentence is the link
              to the cookie policy at the end of it — which is the one part that must survive. */}
          <p className="text-xs sm:text-sm text-muted sm:flex-1 sm:min-w-0">
            {c.body} <Link href={POLICY_HREF} className="text-accent hover:underline">{c.policyLink}</Link>.
          </p>
          {/* ICO: reject must be NO HARDER than accept. Same size, same row, adjacent — the only
              difference is which one is filled, and Manage is the quiet third. */}
          <div className="flex items-center gap-2 shrink-0">
            <button data-testid="consent-accept" className={btnPrimary} onClick={() => setChoice(ALL_ON)}>{c.acceptAll}</button>
            <button data-testid="consent-reject" className={btnEqual} onClick={() => setChoice(ALL_OFF)}>{c.rejectAll}</button>
            <button data-testid="consent-manage" className={btnGhost} onClick={() => setManaging(true)}>{c.manage}</button>
          </div>
        </div>
      </div>

      {/* ── CATEGORIES, AS A MODAL ────────────────────────────────────────────────────────────
          Opened on purpose, so covering the page is legitimate here in a way it never was for the
          resting bar. aria-modal is true and the backdrop closes it — a consent dialog with no way
          out but a choice is its own dark pattern. Scrollable, because four categories plus their
          descriptions genuinely do not fit a short phone in landscape. */}
      {managing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true"
          aria-label={c.title} data-testid="consent-modal">
          <div className="absolute inset-0 bg-black/40" onClick={() => setManaging(false)} aria-hidden="true" />
          <div className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto bg-surface border border-line rounded-2xl shadow-xl p-5">
            <h2 className="text-base font-semibold text-ink">{c.title}</h2>
            <p className="text-sm text-muted mt-1">
              {c.body} <Link href={POLICY_HREF} className="text-accent hover:underline">{c.policyLink}</Link>.
            </p>
            <div className="mt-3">
              <Row k="necessary" on locked />
              <Row k="functional" on={choice.functional} />
              <Row k="analytics" on={choice.analytics} />
              <Row k="marketing" on={choice.marketing} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <button data-testid="consent-save" className={btnPrimary} onClick={() => setChoice(choice)}>{c.save}</button>
              <button className={btnEqual} onClick={() => setChoice(ALL_ON)}>{c.acceptAll}</button>
              <button className={btnEqual} onClick={() => setChoice(ALL_OFF)}>{c.rejectAll}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
