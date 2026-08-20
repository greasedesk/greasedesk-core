/**
 * File: components/DocumentCredit.tsx
 * The maker's mark, for the WEB surfaces. See lib/product-credit for what it is, why it says
 * "with" rather than "by", and why there is no way to turn it off.
 *
 * ── NO PROPS THAT COULD SUPPRESS IT ─────────────────────────────────────────────────────────────
 * It takes a className for spacing and nothing else. There is no `show`, no `hidden`, no `tier` —
 * a component that can be told not to render is a component somebody will eventually tell not to
 * render. The one thing a caller decides is where it sits, and it must sit beneath the garage's
 * own name: adjacency is what stops the line reading as though GreaseDesk issued the document.
 *
 * The PDF cannot use this (react-pdf has its own primitives) and composes the same constants
 * itself — lib/product-credit is the shared truth, not this file.
 */
import React from 'react';
import { CREDIT_PREFIX, CREDIT_DOMAIN, CREDIT_HREF } from '@/lib/product-credit';

export default function DocumentCredit({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[11px] text-muted ${className}`} data-testid="document-credit">
      {CREDIT_PREFIX} ·{' '}
      <a href={CREDIT_HREF} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
        {CREDIT_DOMAIN}
      </a>
    </p>
  );
}
