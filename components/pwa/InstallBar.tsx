/**
 * File: components/pwa/InstallBar.tsx
 * In-app "Add to home screen" (a mechanic will never find Chrome's ⋮ → Install app menu):
 *  - Chromium: capture beforeinstallprompt, show a bar with an Install button that fires it.
 *  - iOS Safari: no such event — show the instruction with the SHARE GLYPH drawn, not described.
 *  - Hidden entirely when already installed (display-mode: standalone / navigator.standalone).
 *  - Dismissible, remembered per browser.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';

const DISMISS_KEY = 'gd-install-dismissed';

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  } catch { return false; }
}
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document); // iPadOS masquerades as Mac
  return ios && !isStandalone();
}

const ShareGlyph = () => (
  // The iOS share symbol: square with an up arrow.
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-2px]" aria-hidden="true">
    <path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
  </svg>
);

export default function InstallBar() {
  const { t } = useTranslation('pwa');
  const [prompt, setPrompt] = useState<any>(null); // the stashed beforeinstallprompt event
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (isStandalone()) return; // installed — nothing to say
    try { if (localStorage.getItem(DISMISS_KEY) === '1') return; } catch { /* show */ }
    setIos(isIosSafari());
    setHidden(false);
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const dismiss = () => { setHidden(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* pref only */ } };
  const install = async () => {
    if (!prompt) return;
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') setHidden(true);
    setPrompt(null);
  };

  // Chromium shows the bar only once the event arrives; iOS shows the instruction unconditionally.
  if (hidden || (!ios && !prompt)) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm bg-accent-soft text-accent border-b border-line">
      <span className="flex-1 min-h-[44px] flex items-center">
        {ios ? (<span>{t('installIos1')} <ShareGlyph /> {t('installIos2')}</span>) : t('installTitle')}
      </span>
      {!ios && (
        <button onClick={install} className="min-h-[44px] rounded-lg px-4 text-sm font-semibold bg-accent text-white">{t('installButton')}</button>
      )}
      <button onClick={dismiss} aria-label={t('installDismiss')} className="min-h-[44px] min-w-[44px]">✕</button>
    </div>
  );
}
