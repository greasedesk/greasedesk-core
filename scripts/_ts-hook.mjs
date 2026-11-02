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

/**
 * ── AND LOAD .tsx, WHICH NODE CANNOT ────────────────────────────────────────────────────────────
 * `node --experimental-strip-types` removes TYPE ANNOTATIONS. JSX is not an annotation, it is
 * syntax with a runtime meaning, so a `.tsx` file fails with
 *
 *   TypeError: Unknown file extension ".tsx"
 *
 * `.tsx` has been in the EXTS list above since this hook was written, so the resolver would hand a
 * gate a component and the loader would then refuse it. The consequence was quiet: a component's
 * PRINTED WORDS could only be asserted through a browser, which means a dev server, a tenant and a
 * fixture — so in practice they were asserted by reading the source and hoping, or not at all.
 *
 * Transpiled with the repo's own `typescript`, which is already a dependency of `npm run
 * type-check`, and with its own tsconfig's JSX setting left alone: this emits the classic
 * `React.createElement` form, so a gate renders with `react-dom/server` and no build step.
 *
 * SCRIPTS ONLY, like the rest of this file. Nothing in the app loads this hook, and a transform
 * that is wrong here cannot reach a page — Next does its own.
 */
export async function load(url, ctx, next) {
  if (!url.endsWith('.tsx')) return next(url, ctx);
  const { readFileSync } = await import('node:fs');
  const ts = (await import('typescript')).default;
  const source = readFileSync(fileURLToPath(url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      // Erased, never emitted: a gate importing a component must not acquire its type-only imports
      // as runtime ones, which is how a presentational component starts dragging lib/db.
      verbatimModuleSyntax: false,
      esModuleInterop: true,
    },
  });
  return { format: 'module', source: outputText, shortCircuit: true };
}
