/**
 * File: scripts/_gate-summary.mjs
 * WHAT THE SUITE SUMMARY SAYS A RED WAS.
 *
 * Its own module, and deliberately side-effect free, so the runner and the gate that tests it can
 * both import it. `gates.mjs` runs the whole suite on import; there is nothing to assert against.
 */

/**
 * ── THE FIRST ✗ LINE IS NOT THE FIRST LINE OF THE FAILURE ───────────────────────────────────────
 * The summary read `out.match(/^✗.*$/m)[0]` — one LINE. Prisma's messages begin with a newline, so
 * a gate whose catch-all printed one produced:
 *
 *     ✗ run completed  —
 *
 * A red with a blank reason, on four gates over a week. Each one had to be re-run by hand to learn
 * what it already knew, and re-running is exactly what makes a transient fault look like nothing.
 * One of them was not transient at all: quote-invoice-sms had been failing on a required column
 * missing from its fixture since cbd67eb, in plain sight, saying nothing.
 *
 * ── WHY ONLY WHEN THE DETAIL IS EMPTY ───────────────────────────────────────────────────────────
 * Continuing onto the next line unconditionally would splice the FOLLOWING check's text onto a
 * failure that simply has no detail — a plausible sentence made of two unrelated halves, which is
 * worse than a short one. So the continuation happens only when the line ends on the separator with
 * nothing after it, and never borrows a line that is itself a check or the totals.
 */
export function firstFailureLine(out, cap = 110) {
  const lines = String(out ?? '').split('\n');
  const i = lines.findIndex((l) => /^✗/.test(l));
  if (i < 0) return null;
  let text = lines[i].trimEnd();
  if (/—\s*$/.test(text)) {
    const cont = lines.slice(i + 1).find((l) => l.trim() !== '');
    if (cont && !/^\s*[✓✗]/.test(cont) && !/\d+ failures of \d+/.test(cont)) text = `${text} ${cont.trim()}`;
  }
  return text.slice(0, cap);
}
