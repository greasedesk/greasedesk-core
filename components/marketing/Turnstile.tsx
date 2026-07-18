/**
 * File: components/marketing/Turnstile.tsx
 * Cloudflare Turnstile widget for the public forms (privacy-friendly, no image puzzles, no consent
 * banner). Renders only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set — otherwise nothing renders and the
 * server verification is skipped (see lib/turnstile), so the form isn't broken before the keys land.
 * Calls onToken with the solved token (or null when it expires/errors) so the form can gate submit.
 */
import { useEffect, useRef } from 'react';
import Script from 'next/script';

declare global {
  interface Window { turnstile?: { render: (el: HTMLElement, opts: any) => string; reset: (id?: string) => void } }
}

export default function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const boxRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey) return;
    let stop = false;
    const tryRender = () => {
      if (stop || widgetIdRef.current || !window.turnstile || !boxRef.current) return false;
      widgetIdRef.current = window.turnstile.render(boxRef.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      });
      return true;
    };
    if (tryRender()) return;
    const iv = setInterval(() => { if (tryRender()) clearInterval(iv); }, 200);
    return () => { stop = true; clearInterval(iv); };
  }, [siteKey]);

  if (!siteKey) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />
      <div ref={boxRef} className="mt-1" />
    </>
  );
}
