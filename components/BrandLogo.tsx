/**
 * File: components/BrandLogo.tsx
 * The GreaseDesk logo on a light "plate" so the fixed-colour transparent PNG (which has dark-navy
 * parts) always reads against the dark rail. One place to swap for a proper light/SVG variant later.
 */
import React from 'react';
import Link from 'next/link';

const LOGO_SRC = '/greasedesk-logo-source.png';

export default function BrandLogo({ width = 140, href = '/admin/dashboard', slim = false }: { width?: number; href?: string; slim?: boolean }) {
  // slim = the compact mobile-header variant (thin plate); the desktop sidebar keeps the full plate.
  const img = (
    <span className={`inline-block bg-surface shadow-card ${slim ? 'rounded-lg p-1' : 'rounded-xl p-2.5'}`}>
      <img src={LOGO_SRC} alt="GreaseDesk" style={{ width, height: 'auto', display: 'block' }} />
    </span>
  );
  return href ? <Link href={href} className="inline-block">{img}</Link> : img;
}
