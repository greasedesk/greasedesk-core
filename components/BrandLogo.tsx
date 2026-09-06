/**
 * File: components/BrandLogo.tsx
 * The GreaseDesk logo on a light "plate" so the fixed-colour transparent PNG (which has dark-navy
 * parts) always reads against the dark rail. One place to swap for a proper light/SVG variant later.
 *
 * THE PLATE IS bg-white, NOT bg-surface. It is not chrome that should follow the theme — it is a
 * guaranteed light ground for artwork that cannot change colour. Under the Engine Room's dark theme
 * bg-surface resolves to #1E293B, and the logo's dark-navy half vanished into the plate meant to
 * rescue it. Identical in the tenant app, where --surface is #FFFFFF anyway.
 */
import React from 'react';
import Link from 'next/link';

/**
 * THE FLAT LOCKUP, not the glow render.
 *
 * This pointed at greasedesk-logo-source.png: 1536x1024 and 1.93 MB, on every admin page, to draw
 * something 132px wide. The weight was the GLOW — a soft radial gradient, which PNG compresses
 * terribly — and two thirds of the canvas was empty padding around it, so the visible mark was
 * smaller than the box suggested. It is a hero render that got wired into the UI.
 *
 * greasedesk-Logo.png is the same artwork, flat and tightly cropped: 1022x353 and 186 KB, already
 * the OG/schema image (lib/company-info). At 1022px against a 132px render it is 7.7x — ample at
 * any density — and one tenth the bytes.
 *
 * THE CAPITAL L IS LOAD-BEARING. macOS is case-insensitive and Vercel is not, so a lowercased path
 * works locally and 404s in production. engine-room-palette-gate checks this string against the
 * real directory listing, which is case-sensitive, rather than against a filesystem that forgives.
 */
const LOGO_SRC = '/greasedesk-Logo.png';

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
    <span className={`inline-block bg-white shadow-card ${slim ? 'rounded-lg p-1' : 'rounded-xl p-2.5'}`}>
      {image}
    </span>
  ) : image;
  return href ? <Link href={href} className="inline-block">{img}</Link> : img;
}
