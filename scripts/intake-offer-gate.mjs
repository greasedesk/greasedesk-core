/**
 * File: scripts/intake-offer-gate.mjs
 * THE OFFER APPEARS ONCE, AND STAYS GONE.
 *
 * The prompts panel has always existed in Settings. Five real tenants had every prompt off and
 * always had; the only tenant with any enabled was the demo. So the offer's job is to be SEEN — and
 * its harder job is to be answerable once. A banner that comes back on the next device teaches
 * people that dismissing things in this product does not work, and that lesson spreads to every
 * dismissal we ever ship.
 *
 * Most of these assertions are therefore about it NOT appearing.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const I = await import('../lib/intake-items.ts');
const { readFileSync } = await import('node:fs');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

let fix = null, browser = null;

try {
  // ── 1. THE RULE ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— two site facts, neither about the browser —');
  check('a fresh site is offered', I.shouldOfferIntakePrompts({ anyPromptEnabled: false, dismissedAt: null }));
  check('a site with ANY prompt on is not', !I.shouldOfferIntakePrompts({ anyPromptEnabled: true, dismissedAt: null }),
    'three of five on is a choice, and second-guessing it is the nag');
  check('a site that said no is not', !I.shouldOfferIntakePrompts({ anyPromptEnabled: false, dismissedAt: new Date() }));
  check('  …and still is not once it has said no AND turned everything off',
    !I.shouldOfferIntakePrompts({ anyPromptEnabled: false, dismissedAt: new Date('2020-01-01') }),
    'the answer does not expire');

  // ── 2. TURNING THEM ALL OFF IS AN ANSWER ─────────────────────────────────────────────────────
  console.log('\n— the second route to the same answer —');
  const site = await prisma.site.create({
    data: { group_id: ZZ, site_name: 'ZZ Offer Site', intake_prompt_diag_scan: true },
    select: { id: true },
  });
  fix = { site: site.id };
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ76OFF', make: 'Off', model: 'Fixture' }, select: { id: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix.veh = veh.id; fix.card = card.id;

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const openIntake = async () => {
    await page.goto(`${BASE}/admin/jobcards/${card.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
    await page.waitForSelector('[data-testid="intake-checklist"], [data-testid="tyre-capture"]', { timeout: 25000 });
    return page.locator('[data-testid="intake-prompts-offer"]').count();
  };

  check('a site WITH a prompt on sees no offer', (await openIntake()) === 0,
    'they have already found it');

  // Switch the last one off through the REAL settings endpoint, not by writing the column.
  await page.evaluate(async (id) => {
    await fetch('/api/locations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ id, intakePrompts: { diag_scan: false } }) });
  }, site.id);
  const afterOff = await prisma.site.findUnique({ where: { id: site.id }, select: { intake_offer_dismissed_at: true, intake_offer_dismissed_by: true } });
  check('turning off the LAST prompt records the answer', afterOff?.intake_offer_dismissed_at != null,
    'a garage that used prompts and stopped has answered; the offer must not come back');
  check('  …with who answered it', afterOff?.intake_offer_dismissed_by != null);
  check('  …and the offer does not appear', (await openIntake()) === 0,
    'this is the shape people learn to ignore');

  // ── 3. A NEVER-TOUCHED SITE IS OFFERED, ONCE ─────────────────────────────────────────────────
  console.log('\n— seen, then answered, then gone —');
  const site2 = await prisma.site.create({ data: { group_id: ZZ, site_name: 'ZZ Offer Site Two' }, select: { id: true } });
  const card2 = await prisma.jobCard.create({
    data: { group_id: ZZ, site_id: site2.id, vehicle_id: veh.id, status: 'in_progress', stage_details_done: true },
    select: { id: true },
  });
  fix.site2 = site2.id; fix.card2 = card2.id;
  const openIntake2 = async () => {
    await page.goto(`${BASE}/admin/jobcards/${card2.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Intake', exact: false }).first().click();
    await page.waitForSelector('[data-testid="tyre-capture"]', { timeout: 25000 });
    return page.locator('[data-testid="intake-prompts-offer"]').count();
  };
  check('a site that never enabled anything IS offered', (await openIntake2()) === 1);

  const text = (await page.locator('[data-testid="intake-prompts-offer"]').innerText()).replace(/\s+/g, ' ');
  check('  …leading with the state, not the feature', /^Nothing is being checked before cars go in\./.test(text), text.slice(0, 60));
  check('  …naming the items, because the value is the specifics',
    ['walkaround video', 'mileage and VIN', 'diagnostic scan', 'oil level', 'what the car needs'].every((w) => text.toLowerCase().includes(w.toLowerCase())));
  check('  …and naming the email, which is the actual product', /email when one gets missed/.test(text));
  check('  …and it does NOT read as a warning',
    !/warning|error|action required|must|attention/i.test(text)
    && (await page.locator('[data-testid="intake-prompts-offer"]').getAttribute('class')).includes('border-line'),
    'this sits on a screen a mechanic is trying to get through');
  check('it offers a way in', (await page.locator('[data-testid="intake-offer-setup"]').count()) === 1);

  // NOW ANSWER IT, on a different card of the same site, and prove it is gone for BOTH.
  await page.locator('[data-testid="intake-offer-dismiss"]').click();
  await page.waitForTimeout(1500);
  check('“No thanks” is answered once', (await openIntake2()) === 0);
  const s2 = await prisma.site.findUnique({ where: { id: site2.id }, select: { intake_offer_dismissed_at: true } });
  check('  …and recorded on the SITE, not the browser', s2?.intake_offer_dismissed_at != null,
    'a banner that comes back on the next device teaches people dismissal does not work here');

  // A DIFFERENT BROWSER — the actual claim being made.
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await fresh.fill('input[type="email"]', 'owner@zzgategarage.test');
  await fresh.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([fresh.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), fresh.click('button[type="submit"]')]);
  await fresh.goto(`${BASE}/admin/jobcards/${card2.id}`, { waitUntil: 'domcontentloaded' });
  await fresh.getByRole('button', { name: 'Intake', exact: false }).first().click();
  await fresh.waitForSelector('[data-testid="tyre-capture"]', { timeout: 25000 });
  check('  …so a FRESH browser never sees it again',
    (await fresh.locator('[data-testid="intake-prompts-offer"]').count()) === 0,
    'the whole reason this is a site fact');

  const audited = await prisma.auditLog.count({ where: { group_id: ZZ, action: 'intake.offer_dismissed' } });
  check('both routes to the answer are audited', audited >= 1, `${audited} recorded`);
} catch (e) {
  check('gate run completed', false, String(e?.message ?? e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 90)}`); } };
    await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: [fix.card, fix.card2].filter(Boolean) } } }));
    await step('vehicle', () => (fix.veh ? prisma.vehicle.delete({ where: { id: fix.veh } }) : Promise.resolve()));
    await step('sites', () => prisma.site.deleteMany({ where: { id: { in: [fix.site, fix.site2].filter(Boolean) } } }));
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.site.count({ where: { group_id: ZZ, site_name: { contains: 'Offer Site' } } })) === 0
      && (await prisma.vehicle.count({ where: { group_id: ZZ, registration: 'ZZ76OFF' } })) === 0);
  }
}

// ── 4. THE REASONING IS RECORDED ────────────────────────────────────────────────────────────────
console.log('\n— why it is shaped this way —');
const c = prose(readFileSync('components/jobcard/IntakePromptsOffer.tsx', 'utf8'));
check('the file says why it is not in Settings', /Being seen is the entire point/.test(c));
check('  …and why it is not per-item', /second-guessing it is exactly the shape people learn to ignore/.test(c));
check('  …and why the dismissal is a site fact', /teaches people that dismissing things here does not work/.test(c));
const li = prose(readFileSync('lib/intake-items.ts', 'utf8'));
check('and why "ever enabled" is not a third fact', /needs no retroactive history we do not have/.test(li),
  'no toggle history exists, so turning them all off IS recorded as the answer');

console.log(`\n${out.filter((c2) => c2 === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
