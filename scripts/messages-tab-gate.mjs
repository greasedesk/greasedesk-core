/**
 * File: scripts/messages-tab-gate.mjs
 * The Messages tab: not part of the gated spine, and its badge clears on a CLICK, not a render.
 *
 * ── WHY THE NON-STAGE RULE IS ASSERTED EXPLICITLY ───────────────────────────────────────────────
 * Every other entry in TAB_KEYS is a stage with a completion flag. The next person adding a tab
 * will copy whichever one they read first, and if that is Intake they will wire a stage flag to a
 * conversation. So "always reachable, never completable" is a gate, not a comment.
 *
 * ── AND WHY "OPEN" IS A CLICK ───────────────────────────────────────────────────────────────────
 * The active tab comes from ?tab= in the URL, so a card can load straight onto Messages from a link
 * or a back-navigation. Clearing on render would mark a customer's reply read because somebody's
 * browser restored a tab. The messages centre already solved this with its `userPicked` guard; the
 * job card uses selectTab, which only runs from the tab strip's onSelect. Same convention.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { TAB_KEYS, NON_STAGE_TABS, TAB_STAGE, computeTabs } = await import('../lib/jobcard-tabs.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
// PORT 3000, the port `npm run dev` uses. This defaulted to 3111 — not a decision, just whatever
// the author had running that afternoon. Six gates carried defaults like it, so six gates skipped
// on every machine but one; both of the two tested pass unchanged against 3000. GATE_BASE still
// overrides, which is what a genuinely different server is for.
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let threadId = null, restoreUnread = null, browser = null;
try {
  // ── 1. THE TAB MODEL ───────────────────────────────────────────────────────────────────────
  console.log('\n— not part of the spine —');
  check('messages sits between details and quote', TAB_KEYS.indexOf('messages') === 1 && TAB_KEYS[2] === 'quote',
    TAB_KEYS.join(' → '));
  check('it is declared a NON-STAGE tab', NON_STAGE_TABS.includes('messages'));
  check('and has no stage flag behind it', !TAB_STAGE.messages,
    'TAB_STAGE maps the gated tabs to their stage; a conversation has none');

  // Every gate state it could ever be in: reachable always, complete never.
  const states = [
    { status: 'draft', stages: {}, hasOwner: false, hasRegistration: false },
    { status: 'draft', stages: { details: true }, hasOwner: true, hasRegistration: true },
    { status: 'invoiced', stages: { details: true, intake: true, injob: true, complete: true }, hasOwner: true, hasRegistration: true },
    { status: 'cancelled', stages: {}, hasOwner: false, hasRegistration: false },
  ];
  const all = states.map((s) => computeTabs(s));
  check('ALWAYS reachable — even on an empty draft with no owner', all.every((t) => t.messages.reachable),
    'a customer can write in before anything else has happened');
  check('NEVER completable, in any state', all.every((t) => t.messages.complete === false),
    '"complete" is meaningless for a conversation — it is never finished, only quiet');
  check('and it gates nothing after it: Quote still depends on DETAILS',
    computeTabs(states[0]).quote.reachable === false && computeTabs(states[1]).quote.reachable === true,
    'reading the tab ORDER as the dependency chain is the mistake this guards');
  // Discriminating: a stage tab does the opposite on the same inputs.
  check('the check is discriminating — intake IS gated and completable',
    computeTabs(states[0]).intake.reachable === false && computeTabs(states[2]).intake.complete === true);

  // ── 2. CLEARING IS A CLICK ─────────────────────────────────────────────────────────────────
  console.log('\n— open means clicked —');
  const ws = readFileSync('components/jobcard/JobCardWorkspace.tsx', 'utf8');
  check('the clear happens inside selectTab', /async function selectTab[\s\S]{0,200}k === 'messages'[\s\S]{0,40}openMessages\(\)/.test(ws),
    'selectTab only runs from the tab strip onSelect — the equivalent of the centre’s userPicked');
  check('and NOT from an effect on the active tab', !/useEffect\([\s\S]{0,200}active === 'messages'[\s\S]{0,200}messages\/read/.test(ws),
    'the active tab comes from ?tab=, so a restored tab would mark a reply read with nobody reading it');
  check('it reuses the existing endpoint rather than a second one', /'\/api\/messages\/read'/.test(ws));
  const centre = readFileSync('pages/admin/messages.tsx', 'utf8');
  check('the messages centre still guards on userPicked', /if \(!sel \|\| !userPicked\) return;/.test(centre),
    'one convention, followed — not copied blindly and not reinvented');

  // ── 3. THE COUNT IS THIS THREAD'S, NOT THE TENANT'S ────────────────────────────────────────
  console.log('\n— the badge —');
  const conv = readFileSync('lib/message-threads.ts', 'utf8');
  check('conversationForJobCard carries the thread’s own unread', /unread: \(t as any\)\.unread_count \?\? 0/.test(conv));
  check('the sidebar total is a DIFFERENT number', /export async function unreadThreadCount/.test(conv),
    'the tab says what is waiting here; the sidebar says what is waiting anywhere');

  // ── 4. ON THE SERVED PAGE ──────────────────────────────────────────────────────────────────
  console.log('\n— on the served card —');
  const thread = await prisma.messageThread.findFirst({
    where: { group_id: ZZ }, select: { id: true, unread_count: true, customer_id: true, vehicle_id: true },
  });
  if (!thread) throw new Error('no ZZ thread to work against');
  threadId = thread.id; restoreUnread = thread.unread_count;
  const card = await prisma.jobCard.findFirst({
    where: { group_id: ZZ, vehicle_id: thread.vehicle_id }, select: { id: true }, orderBy: { created_at: 'desc' },
  });
  if (!card) throw new Error('no ZZ card on that thread’s vehicle');
  // A real unread, so the badge has something to show. Restored in the finally.
  await prisma.messageThread.update({ where: { id: threadId }, data: { unread_count: 3 } });

  const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${B}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  await page.goto(`${B}/admin/jobcards/${card.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="tab-badge-messages"]', { timeout: 25000 });
  check('the badge shows the count', (await page.locator('[data-testid="tab-badge-messages"]').innerText()).trim() === '3');
  check('the tab is present and enabled', await page.getByRole('button', { name: 'Messages', exact: false }).first().isEnabled());

  // RENDERING THE CARD DID NOT CLEAR IT.
  check('merely loading the card did NOT mark it read',
    (await prisma.messageThread.findUnique({ where: { id: threadId }, select: { unread_count: true } })).unread_count === 3,
    'this is the case a render-based clear would get wrong');

  await page.getByRole('button', { name: 'Messages', exact: false }).first().click();
  await page.waitForSelector('[data-testid="compose-channel"]', { timeout: 20000 });
  check('the panel is on the Messages tab now', await page.locator('[data-testid="compose-channel"]').count() === 1,
    'moved from Customer Details, same component');
  await page.waitForTimeout(1200);
  check('CLICKING it clears the unread', (await prisma.messageThread.findUnique({ where: { id: threadId }, select: { unread_count: true } })).unread_count === 0);
  check('and the badge goes', await page.locator('[data-testid="tab-badge-messages"]').count() === 0);

  // The panel must not ALSO still be on Details.
  await page.getByRole('button', { name: 'Customer Details', exact: false }).first().click();
  await page.waitForTimeout(600);
  check('Customer Details no longer carries the conversation', await page.locator('[data-testid="compose-channel"]').count() === 0,
    'moved, not duplicated');
  check('and its Save + stage buttons are still there', await page.locator('[data-testid="details-save"]').count() === 1
    && await page.locator('[data-testid="stage-complete-details"]').count() === 1);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (threadId !== null && restoreUnread !== null) {
    await prisma.messageThread.update({ where: { id: threadId }, data: { unread_count: restoreUnread } });
    const now = (await prisma.messageThread.findUnique({ where: { id: threadId }, select: { unread_count: true } })).unread_count;
    check('teardown restored the thread’s unread exactly', now === restoreUnread, `${restoreUnread} → ${now}`);
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
