/**
 * File: scripts/pwa-intake-gate.mjs
 * THE INTAKE CAPTURE REACHES THE PHONE — the surface the mechanic is actually holding.
 *
 * The whole feature was built on a desktop nobody stands at, which made the measured 4.5s capture
 * meaningless. These assertions defend the phone path: the outbox kinds, their replay safety, the
 * checklist being present at all, and the no-default rule surviving onto the surface where tapping
 * through at speed is most tempting.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const PS = await import('../lib/photo-slots.ts');
const { readFileSync } = await import('node:fs');
const out = [];
/* Prose assertions have been bitten repeatedly by line wrapping: a sentence that reads as one line
 * on screen is "the\n * whole" in the file. Collapse the comment leaders and the whitespace before
 * matching, so the gate tests the SENTENCE rather than the column at which it happened to break. */
const prose = (s) => s.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const outbox = readFileSync('lib/pwa-outbox.ts', 'utf8');
const sw = readFileSync('public/sw.js', 'utf8');
const page = readFileSync('pages/m/job/[id].tsx', 'utf8');
const api = readFileSync('pages/api/pwa/job/[id].ts', 'utf8');

// ── 1. THE TWO NEW KINDS RIDE THE EXISTING ENVELOPE ─────────────────────────────────────────────
console.log('\n— two kinds, not two pipelines —');
check("the envelope carries 'due_item' and 'tyres'", /'photo' \| 'vehicle' \| 'video' \| 'due_item' \| 'tyres'/.test(outbox));
check('enqueueDueItem parks durably BEFORE any network', /enqueueDueItem[\s\S]{0,900}?await rw\(\(s\) => s\.put\(item\)\)/.test(outbox));
check('enqueueTyres does too', /enqueueTyres[\s\S]{0,900}?await rw\(\(s\) => s\.put\(item\)\)/.test(outbox));
check('the service worker has a sender for each', /item\.kind === 'due_item'/.test(sw) && /item\.kind === 'tyres'/.test(sw));
check('  …and unknown kinds still fail terminally', /unknown-kind/.test(sw), 'a typo must not retry forever');

// ── 2. REPLAY SAFETY, THE TWO DIFFERENT WAYS ────────────────────────────────────────────────────
console.log('\n— a queue replays, so both kinds must survive it —');
check('the finding sender sends the envelope id AS the row id', /id: item\.id, jobCardId: item\.jobCardId/.test(sw),
  'a due item has no natural key — without this a dead-signal bay records one finding and the garage gets two');
check('the tyre sender sends NO id', /'\/api\/tyre-readings'[\s\S]{0,220}?jobCardId: item\.jobCardId, corners/.test(sw)
  && !/tyre-readings[\s\S]{0,220}?id: item\.id/.test(sw),
  '(job_card_id, corner) is a natural key, so a replay upserts by construction');
check('and the difference is explained where the next reader will be',
  /no natural key/i.test(prose(outbox)) && /a due item has no natural key/i.test(prose(readFileSync('pages/api/due-items.ts', 'utf8'))));

// ── 3. THE CHECKLIST IS ON THE PHONE ────────────────────────────────────────────────────────────
console.log('\n— an escalation must not name items nobody was asked for —');
check('the phone renders the checklist', /<PhoneIntakeChecklist/.test(page));
check('  …fed by the phone payload', /intakeItems: p\.intakeItems/.test(api));
const cl = readFileSync('components/pwa/PhoneIntakeChecklist.tsx', 'utf8');
check('the clean-car affirmative is one tap here too', /ph-nothing-found/.test(cl) && /Nothing found/.test(cl));
check('  …and the reason it matters is recorded', /false positives are how the whole escalation design dies/i.test(prose(cl)));

// ── 4. THE NO-DEFAULT RULE SURVIVES THE SMALL SCREEN ────────────────────────────────────────────
console.log('\n— the surface where tapping through is most tempting —');
const pf = readFileSync('components/pwa/PhoneFindings.tsx', 'utf8');
check('basis starts NULL', /useState<Basis \| null>\(null\)/.test(pf));
check('answer starts NULL', /useState<Answer \| null>\(null\)/.test(pf));
check('Save is disabled until both are chosen', /basis !== null && answer !== null/.test(pf));
check('  …and the reason is stated for the phone specifically', /most tempting/i.test(prose(pf)));
check('the MOT is shown read-only so nobody retypes it', /ph|phone-mot/.test(pf) && /no need to record it/.test(pf));

// ── 5. TOUCH TARGETS ────────────────────────────────────────────────────────────────────────────
console.log('\n— a gloved thumb, not a mouse —');
const pt = readFileSync('components/pwa/PhoneTyres.tsx', 'utf8');
check('tyre depth chips are ≥44px', /min-h-\[44px\] min-w-\[46px\]/.test(pt));
check('finding controls are ≥44px', /min-h-\[44px\]/.test(pf));
check('primary actions are ≥48px', /min-h-\[48px\]/.test(pt) && /min-h-\[48px\]/.test(pf));
check('no <select> anywhere in the phone capture', !/<select/.test(pt) && !/<select/.test(pf),
  'tap-scroll-tap behind a native wheel that covers the screen');

// ── 6. SEND: CAPTURE-FIRST, WARNING INTACT ──────────────────────────────────────────────────────
console.log('\n— the action travels, the ledger does not —');
const ps = readFileSync('components/pwa/PhoneSendReport.tsx', 'utf8');
check('the phone can send', /ph-send-sms/.test(ps) && /ph-send-email/.test(ps));
check('the shareable-link warning is NOT abbreviated', /video and photos of the customer’s car/.test(prose(ps))
  && /whoever receives it can see it too/.test(prose(ps)),
  'a shorter warning on the surface where sending is easiest would be exactly the wrong trade');
check('the reply-status ledger stays on the desktop', !/no reply yet|report-awaiting/.test(ps),
  'a mechanic does not chase responses');
check('sending posts directly rather than queuing', !/enqueue/.test(ps),
  'a report queued in a dead bay would surface to the customer at an unpredictable later moment');

// ── 7. STILL NO MONEY ON THIS SURFACE ───────────────────────────────────────────────────────────
console.log('\n— the standing rule for the phone —');
for (const [f, src] of [['PhoneFindings', pf], ['PhoneTyres', pt], ['PhoneIntakeChecklist', cl], ['PhoneSendReport', ps]]) {
  check(`${f} shows no money`, !/unitPrice|unit_cost|formatMoney|£/.test(src));
}

// ── 8. THE BATTERY, ON THE PHONE ────────────────────────────────────────────────────────────────
console.log('\n— the third measurement kind —');
const pb = readFileSync('components/pwa/PhoneBattery.tsx', 'utf8');
check("the envelope carries 'battery'", /\| 'battery';/.test(outbox));
check('the service worker has a sender for it', /item\.kind === 'battery'/.test(sw));
check('  …which sends NO id, because job_card_id IS the natural key',
  !/battery-readings'[\s\S]{0,400}?id: item\.id/.test(sw)
  && /BatteryReading is unique on job_card_id/.test(prose(sw)),
  'the same argument as tyres, and the opposite of a due item');
check('the phone renders it', /<PhoneBattery/.test(page));
check('  …after the tyres, matching the desktop', page.indexOf('<PhoneBattery') > page.indexOf('<PhoneTyres'));
check('  …fed by the prefilled rating', /lastBattery: p\.lastBattery/.test(api));
check('the save parks durably before any network', /enqueueBattery/.test(pb) && !/fetch\(/.test(pb));
check('all three numbers are required together', /ok\(v, 0\.1, 30\) && ok\(sc, 0, 100\) && ok\(sh, 0, 100\)/.test(pb),
  'a test missing one number silently changes which state it lands in');
check('the rating is both-or-neither on the phone too',
  /ratedCca\.trim\(\) === '' && std === ''/.test(pb));
check('numeric keypads, not the alphabet', /inputMode="decimal"/.test(pb) && (pb.match(/inputMode="numeric"/g) || []).length >= 3);
check('no chips on a voltage', !/CHIPS/.test(pb) && /cannot be chipped/.test(prose(pb)),
  'chips would round away the precision that makes the reading evidence');
check('touch targets stay at 48px', (pb.match(/min-h-\[48px\]/g) || []).length >= 3);
check('PhoneBattery shows no money', !/unitPrice|unit_cost|formatMoney|£/.test(pb));

// ── 9. THE SLOT CHOKEPOINT ──────────────────────────────────────────────────────────────────────
console.log('\n— asked positively, so the next section is free —');
const slots = readFileSync('lib/photo-slots.ts', 'utf8');
const rep = readFileSync('lib/intake-report.ts', 'utf8');
check('the report asks whether a section owns the slot', /!slotOwnedBySection\(m\.slot\)/.test(rep));
check('  …and no longer names one section negatively', !/!cornerFromSlot\(m\.slot\)/.test(rep),
  'that version would have double-shown the battery photos');
// BEHAVIOURALLY, not by grepping for the name. The first version of this checked that the source
// mentioned BATTERY_SLOTS — which the IMPORT line satisfies, so deleting the registration itself
// left the assertion green. A registry has to be asked the question, not read.
check('both tyre corners and battery slots are registered',
  PS.slotOwnedBySection('tyre_front_left') && PS.slotOwnedBySection('battery_result')
  && PS.slotOwnedBySection('battery_voltage'));
check('  …and the general grid still owns everything else',
  !PS.slotOwnedBySection('damage') && !PS.slotOwnedBySection('vin') && !PS.slotOwnedBySection('freeform')
  && !PS.slotOwnedBySection(null));
check('the reason it is positive is written down', /negative filter that names one section/.test(prose(slots)));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
