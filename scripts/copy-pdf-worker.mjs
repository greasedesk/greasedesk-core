/**
 * File: scripts/copy-pdf-worker.mjs
 * Copies the pdf.js worker out of node_modules into /public so the browser can fetch it
 * same-origin. It cannot be `import`ed — webpack refuses to bundle an ESM worker entry — and it
 * must not come from a CDN, because that would route a customer's invoice through a third party.
 * Run from `prebuild`, so a pdfjs-dist upgrade can never leave a stale worker behind.
 */
import { copyFileSync } from 'node:fs';
const from = 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
copyFileSync(from, 'public/pdf.worker.min.mjs');
console.log('copied', from, '→ public/pdf.worker.min.mjs');
