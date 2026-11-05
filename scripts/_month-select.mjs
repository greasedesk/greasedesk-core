/**
 * File: scripts/_month-select.mjs
 * READING AND SETTING A MONTH, FROM A GATE — one helper, because three gates need it.
 *
 * components/ui/MonthSelect replaced `<input type="month">` with two `<select>`s, so
 * `inputValue('[data-testid=…]')` and `fill(…, '2026-09')` no longer address anything: the testid
 * is now a wrapper carrying `<testid>-month` and `<testid>-year` inside it.
 *
 * THIS IS HERE RATHER THAN IN EACH GATE because three of them drive the same control, and three
 * hand-rolled versions of "select the year, then select the month" is three chances to select them
 * in an order the component does not expect — and one of them to be quietly wrong for a year. The
 * same argument as the component itself: one control, one way to drive it.
 *
 * ── THE ORDER MATTERS, AND IT IS NOT ARBITRARY ──────────────────────────────────────────────────
 * The year goes first. Either order composes the same `YYYY-MM`, but a half-filled picker emits ''
 * and a parent may react to that; setting the year first means the only intermediate state the form
 * ever sees is "a year, no month", which is the state a person produces anyway when they start from
 * the right-hand select. Nothing depends on it today; it is fixed so nothing can start to.
 */

/** The composed `YYYY-MM` the control is showing, or '' when either half is unset. */
export async function readMonth(scope, testId) {
  const month = await scope.locator(`[data-testid="${testId}-month"]`).inputValue();
  const year = await scope.locator(`[data-testid="${testId}-year"]`).inputValue();
  return year && month ? `${year}-${month}` : '';
}

/** Set it from a `YYYY-MM`, or clear both halves with ''. */
export async function setMonth(scope, testId, value) {
  const [year, month] = String(value ?? '').split('-');
  await scope.locator(`[data-testid="${testId}-year"]`).selectOption(value ? year : '');
  await scope.locator(`[data-testid="${testId}-month"]`).selectOption(value ? month : '');
}

/** Is the control present at all? The wrapper carries the testid, so this still answers it. */
export const monthPresent = async (scope, testId) => (await scope.locator(`[data-testid="${testId}"]`).count()) === 1;
