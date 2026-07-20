/**
 * File: scripts/copy-pdf-worker.mjs
 * Copies pdf.js's worker out of node_modules into /public at build time, so it is SERVED as a
 * static asset rather than bundled. Two reasons: the ~1.3 MB worker must never enter the main
 * bundle (the importer is one rare screen), and vendoring a megabyte into git to achieve that would
 * be worse. Runs as `prebuild`, so Vercel picks it up with no extra configuration.
 */
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
const destDir = join(root, 'public/pdfjs');
const dest = join(destDir, 'pdf.worker.min.mjs');

if (!existsSync(src)) {
  console.warn('[pdf-worker] pdfjs-dist not installed — skipping worker copy.');
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('[pdf-worker] copied to public/pdfjs/pdf.worker.min.mjs');
