import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js'];

const firstThatExists = (base) => {
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  return null;
};

/**
 * Resolve the repo's own modules under `node --experimental-strip-types`.
 *
 * TWO FORMS, because the repo uses both:
 *   `@/lib/x`   — the tsconfig path alias.
 *   `./x`       — an ORDINARY RELATIVE IMPORT WITHOUT AN EXTENSION. tsc and Next resolve these;
 *                 Node's ESM loader does not, so a gate importing lib/jobcard-tabs died on its
 *                 `import … from './jobcard-status'` with ERR_MODULE_NOT_FOUND. That looked like a
 *                 missing file and was a missing resolver rule — twice, months apart, and worked
 *                 around both times by asking a served page instead of the module. Fixed here so
 *                 the next gate can import any lib file the app can.
 *
 * Scripts-only: this hook is registered by scripts/_ts.mjs and never loaded by the app.
 */
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) {
    const hit = firstThatExists(ROOT + spec.slice(2));
    if (hit) return next(pathToFileURL(hit).href, ctx);
  }

  // Relative, extensionless, and coming from a file we can locate.
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[a-z]+$/i.test(spec) && ctx.parentURL?.startsWith('file:')) {
    const hit = firstThatExists(resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec));
    if (hit) return next(pathToFileURL(hit).href, ctx);
  }

  return next(spec, ctx);
}
