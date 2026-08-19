/**
 * File: scripts/spine-gate.mjs
 * THE PROCESS PATH: what may be opened when, and the ONE definition of what blocks the invoice.
 *
 * Two things this exists to hold:
 *   1. Intake is reachable BEFORE a quote (findings inform the quote), while work still cannot
 *      start on a card nobody has agreed to pay for.
 *   2. `stagesRemaining` is read by BOTH the API that refuses and the screen that explains — never
 *      copied. A silent divergence there tells a mechanic the card is ready while the mint 409s.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { computeTabs, TAB_KEYS, tabForStage } = await import('../lib/jobcard-tabs.ts');
const { stagesRemaining, STAGE_KEYS } = await import('../lib/jobcard-status.ts');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const base = { stages: { details: false, intake: false, injob: false, complete: false }, skipped: {}, hasOwner: true, hasRegistration: true };
const at = (o) => computeTabs({ ...base, ...o, stages: { ...base.stages, ...(o.stages ?? {}) } });

// ── 1. INTAKE OPENS BEFORE THE QUOTE ───────────────────────────────────────────────────────────
console.log('\n— a car that arrives to be looked at —');
const draftDetailsDone = at({ status: 'draft', stages: { details: true } });
check('Intake is reachable on a DRAFT card once Details is done', draftDetailsDone.intake.reachable === true,
  'the workshop looks at the car, and what it finds informs the quote');
check('  …and the check is discriminating — Details NOT done keeps it shut',
  at({ status: 'draft' }).intake.reachable === false);

console.log('\n— but work still cannot start without agreement —');
const draftIntakeDone = at({ status: 'draft', stages: { details: true, intake: true } });
check('In-Job stays LOCKED on a draft card even with Intake complete', draftIntakeDone.injob.reachable === false,
  'the work-order rule, stated on its own edge instead of inherited from intake');
const acceptedIntakeDone = at({ status: 'accepted', stages: { details: true, intake: true } });
check('  …and opens once the quote is accepted', acceptedIntakeDone.injob.reachable === true);
check('a DECLINED quote leaves In-Job shut', at({ status: 'declined', stages: { details: true, intake: true } }).injob.reachable === false);

console.log('\n— what did NOT change —');
check('Quote still gates on Details', at({ status: 'draft' }).quote.reachable === false
  && at({ status: 'draft', stages: { details: true } }).quote.reachable === true);
check('Completion still follows In-Job',
  at({ status: 'accepted', stages: { details: true, intake: true, injob: true } }).completion.reachable === true
  && at({ status: 'accepted', stages: { details: true, intake: true } }).completion.reachable === false);
check('Invoice still follows Completion',
  at({ status: 'accepted', stages: { details: true, intake: true, injob: true, complete: true } }).invoice.reachable === true);

// ── 2. ONE RULE, TWO READERS ───────────────────────────────────────────────────────────────────
console.log('\n— stagesRemaining is read, never copied —');
check('all four outstanding on a fresh card', stagesRemaining(base.stages, {}).length === 4);
check('none outstanding when all are done', stagesRemaining({ details: true, intake: true, injob: true, complete: true }, {}).length === 0);
check('a SKIP advances a photo stage', stagesRemaining({ details: true, intake: false, injob: true, complete: true }, { intake: true }).length === 0,
  'a skip is an audited first-class event');
check('but Details can NEVER be skipped', stagesRemaining({ details: false, intake: true, injob: true, complete: true }, { details: true }).length === 1,
  'it is a data gate, not a photo stage');
const api = readFileSync('pages/api/jobcard-status.ts', 'utf8');
const ws = readFileSync('components/jobcard/JobCardWorkspace.tsx', 'utf8');
check('the API calls it', /stagesRemaining\(/.test(api));
check('the screen calls it too', /stagesRemaining\(eff\.stages, eff\.skipped\)/.test(ws));
// THE POINT: no second copy of the conjunction anywhere.
const wsCode = ws.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
check('the hand-maintained mirror is GONE', !/!eff\.stages\.intake && !eff\.skipped\.intake/.test(wsCode),
  'two copies of one rule, diverging silently, is the shape this deletes');
const apiCode = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('  …and so is the inline conjunction it mirrored', !/stage_intake_done \|\| card\.stage_intake_skipped/.test(apiCode));

// ── 3. THE LABEL MAPPING SURVIVED THE EXTRACTION ───────────────────────────────────────────────
console.log('\n— the stage key is not the tab key —');
check("the 'complete' STAGE maps to the 'completion' TAB", tabForStage('complete') === 'completion',
  "t('tab.complete') is not a key that exists — the extraction would have rendered a raw string");
const i18n = JSON.parse(readFileSync('public/locales/en-GB/jobcard.json', 'utf8'));
const missing = STAGE_KEYS.filter((k) => !i18n.tab?.[tabForStage(k)]);
check('every stage has a tab label to render', missing.length === 0, missing.join(', ') || `${STAGE_KEYS.length} stages`);
check('the screen goes through tabForStage', /tabForStage\(k\)/.test(ws));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
