/**
 * File: components/BrandLogo.tsx
 * The GreaseDesk logo on a light "plate" so the fixed-colour transparent PNG (which has dark-navy
 * parts) always reads against the dark rail. One place to swap for a proper light/SVG variant later.
 */
import React from 'react';
import Link from 'next/link';

const LOGO_SRC = '/greasedesk-logo-source.png';

export default function BrandLogo(
  { width = 140, href = '/admin/dashboard', slim = false, plate = true, maxHeight }:
  { width?: number; href?: string; slim?: boolean; plate?: boolean; maxHeight?: number },
) {
  // slim = the compact mobile-header variant (thin plate); the desktop sidebar keeps the full plate.
  //
  // plate=false — for LIGHT chrome. The plate exists solely so the fixed-colour PNG reads against
  // the dark rail; on a white header it is invisible padding that made the logo stand taller than
  // the header it sits in, and it hung out of the corner. maxHeight then bounds the image directly,
  // because the asset's aspect ratio is not something a width alone can be trusted to control.
  const image = (
    <img
      src={LOGO_SRC}
      alt="GreaseDesk"
      style={{ width, height: 'auto', display: 'block', ...(maxHeight ? { maxHeight, width: 'auto' } : {}) }}
    />
  );
  const img = plate ? (
    <span className={`inline-block bg-surface shadow-card ${slim ? 'rounded-lg p-1' : 'rounded-xl p-2.5'}`}>
      {image}
    </span>
  ) : image;
  return href ? <Link href={href} className="inline-block">{img}</Link> : img;
}
