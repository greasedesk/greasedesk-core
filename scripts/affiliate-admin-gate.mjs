/**
 * File: scripts/affiliate-admin-gate.mjs
 * THE ENGINE ROOM'S AFFILIATE SCREEN, AND WHAT SUSPENSION ACTUALLY DOES.
 * @gate-requires: server, db
 *
 * ── THE DEFECT THIS GATE WAS WRITTEN AROUND ─────────────────────────────────────────────────────
 * rewardPaidInvoice SELECTED Rep.suspended_at and used only terms_accepted_at. So suspending an
 * affiliate stopped them taking NEW referrals (lib/attribution answers `suspended` for the code)
 * and went on paying them every month on the garages they already had. The select is the evidence
 * somebody meant to do it; nothing asserted it, so nothing said it was not happening.
 *
 * The clauses below hold the rule as a DATE comparison, in both directions across the boundary —
 * an invoice paid before a suspension was earned fairly and is not taken back; one paid on or after
 * it earns nothing — because a boolean version of this rule passes the obvious test and is wrong
 * about every invoice that was already in flight.
 *
 * ── AND THE SCREEN, DRIVEN AS AN OPERATOR DRIVES IT ─────────────────────────────────────────────
 * The list is read through the real Engine Room on its own host, and the suspend button is PRESSED
 * rather than its endpoint called: what is being proved is that an operator can see who is
 * suspended, press the thing, and be told what it did.
 *
 * ── A RED-PROOF ON A SERVER FILE CAN POISON THE NEXT RUN (2026-10-30) ───────────────────────────
 * The audit clause below went red for two runs after a red-proof had disabled the audit write with
 * `if (false)` and then RESTORED the file. The dev server went on serving the compiled
 * no-audit handler: the endpoint answered `changed: true`, the write never ran, nothing was logged,
 * and the write succeeded when run by hand from a script. Adding one console line to the handler
 * forced a recompile and the clause went green with nothing else changed.
 *
 * So: after a red-proof that edits anything under pages/ or lib/ that the SERVER executes, give it
 * a beat and touch the route before the next run. A green run straight after a restored proof may
 * be testing the proof rather than the code — in either direction.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * One affiliate and two garages prefixed ZZAD, their ledger rows and frozen terms, plus one owner
 * operator — all swept in a registered teardown. The gate's own settings row is NOT used: the
 * screen reads the singleton (a public-facing switch is never taken from a query parameter), so the
 * joining switch is moved and put back like affiliate-site-gate does.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, erOrigin, ER_RESOLVER_ARGS, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('/Users/hugh/Developer/greasedesk-core/node_modules/bcryptjs/index.js')).default;
const { underPath, urlUnder } = await import('../lib/anchored-match.ts');
const AF = await import('../lib/affiliate.ts');
const ADMIN = await import('../lib/affiliate-admin.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const ER = erOrigin();
const PREFIX = 'ZZAD';
const OP_EMAIL = 'zzad-affiliate-admin-gate@greasedesk.test';
const OP_PASS = 'GateAffiliateAdmin!2026';

let prisma, browser;
let joiningBefore = null;
const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX, mode: 'insensitive' } }, select: { id: true } })).map((r) => r.id);
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  if (reps.length) {
    await prisma.commissionEntry.deleteMany({ where: { party_id: { in: reps } } }).catch(() => {});
    await prisma.tenantAffiliateTerms.deleteMany({ where: { affiliate_id: { in: reps } } }).catch(() => {});
    await prisma.twoFactorSecret.deleteMany({ where: { subject_type: 'rep', subject_id: { in: reps } } }).catch(() => {});
  }
  if (groups.length) {
    await prisma.commissionEntry.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.tenantAffiliateTerms.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.tenantAttribution.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.tenantPlanTerms.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.groupBilling.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.group.deleteMany({ where: { id: { in: groups } } }).catch(() => {});
  }
  if (reps.length) await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  await prisma.superAdminAudit.deleteMany({ where: { action: 'affiliate_suspension', target_name_snapshot: { contains: PREFIX } } }).catch(() => {});
  await prisma.operator.deleteMany({ where: { email: OP_EMAIL } }).catch(() => {});
  if (joiningBefore !== null) {
    await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { affiliate_joining_open: joiningBefore } }).catch(() => {});
  }
  return reps.length + groups.length;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  // ── 1. THE RULE, AS A DATE COMPARISON ────────────────────────────────────────────────────────
  console.log('— a suspended code earns nothing, from that moment —');
  const SUSPENDED_ON = new Date('2026-06-15T12:00:00Z');
  check('a code that was never suspended is not refused',
    AF.refuseSuspended({ suspendedAt: null, paidAt: new Date() }) === null);
  check('an invoice paid BEFORE the suspension still earned',
    AF.refuseSuspended({ suspendedAt: SUSPENDED_ON, paidAt: new Date('2026-06-14T23:59:59Z') }) === null,
    'it was earned fairly and a suspension is not a clawback');
  const after = AF.refuseSuspended({ suspendedAt: SUSPENDED_ON, paidAt: new Date('2026-06-16T00:00:00Z') });
  check('  …and one paid AFTER it earns nothing, with the date named',
    typeof after === 'string' && after.includes('2026-06-15'), after);
  check('  …and the boundary is ON the moment, not after it',
    typeof AF.refuseSuspended({ suspendedAt: SUSPENDED_ON, paidAt: SUSPENDED_ON }) === 'string',
    'an invoice clearing in the same instant is the case nobody tests by hand, so it is stated');

  // ── 2. AND THE REWARD PATH READS IT ──────────────────────────────────────────────────────────
  // The rule existing is not the rule being applied: this is the half that was missing.
  console.log('\n— and the reward path actually consults it —');
  // billing_email IS REQUIRED on Group — the error names it, and the sibling gates all pass one.
  const mkGroup = (n) => prisma.group.create({ data: {
    group_name: `${PREFIX} garage ${n}`,
    billing_email: `${PREFIX.toLowerCase()}-${n}@example.invalid`,
    trial_ends_at: new Date(Date.now() + 30 * 86400000),
  }, select: { id: true } });
  const aff = await prisma.rep.create({ data: {
    party_type: 'affiliate', email: `zzad-aff@example.invalid`, name: `${PREFIX} Affiliate`,
    ref_code: `${PREFIX}CODE1`, terms_accepted_at: new Date('2026-01-01T00:00:00Z'),
    social_handle: 'youtube.com/@zzad' }, select: { id: true } });
  const g1 = (await mkGroup(1)).id;
  await AF.freezeTermsAtSignup(prisma, g1, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g1, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date('2026-01-01T00:00:00Z'), source: 'ref_param' } });

  const earnedBefore = await AF.rewardPaidInvoice(prisma, { groupId: g1, invoiceId: `in_${PREFIX}_1`, paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  check('an unsuspended affiliate earns on a paid month', earnedBefore.paid === true, String(earnedBefore.why ?? earnedBefore.amountPennies));

  await prisma.rep.update({ where: { id: aff.id }, data: { suspended_at: SUSPENDED_ON } });
  const earnedAfter = await AF.rewardPaidInvoice(prisma, { groupId: g1, invoiceId: `in_${PREFIX}_2`, paidPennies: 7500, status: 'paid', paidAt: new Date('2026-07-01T00:00:00Z') });
  check('  …and after suspension the NEXT paid month earns nothing',
    earnedAfter.paid === false && /suspended/.test(earnedAfter.why ?? ''), earnedAfter.why);
  check('  …while the month already earned is untouched',
    (await prisma.commissionEntry.count({ where: { group_id: g1, kind: 'accrual' } })) === 1,
    'a suspension is not a clawback — only a refund reverses what was earned');
  // AND AN INVOICE FROM BEFORE THE SUSPENSION, ARRIVING LATE, STILL EARNS. This is why the rule
  // takes the invoice's paid date rather than the clock: a webhook re-delivered after a suspension
  // must not retrospectively unpay a month that was already earned.
  const lateButEarlier = await AF.rewardPaidInvoice(prisma, { groupId: g1, invoiceId: `in_${PREFIX}_3`, paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-02T00:00:00Z') });
  check('  …and a LATE webhook for a month paid before the suspension still earns',
    lateButEarlier.paid === true,
    'dated from the invoice, not from now — the clock would unpay a month that had already been earned');

  await prisma.rep.update({ where: { id: aff.id }, data: { suspended_at: null } });

  // ── 3. THE READ MODEL ────────────────────────────────────────────────────────────────────────
  console.log('\n— what the screen is given —');
  const g2 = (await mkGroup(2)).id;
  await AF.freezeTermsAtSignup(prisma, g2, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.twoFactorSecret.create({ data: { subject_type: 'rep', subject_id: aff.id, phone_e164: '447700900333', phone_verified_at: new Date('2026-02-01T00:00:00Z'), method: 'sms' } });

  const listed = await ADMIN.listAffiliates(prisma);
  const mine = listed.find((a) => a.id === aff.id);
  check('the affiliate is listed with the facts an operator needs',
    !!mine && mine.refCode === `${PREFIX}CODE1` && mine.email === 'zzad-aff@example.invalid' && mine.socialHandle === 'youtube.com/@zzad',
    `${mine?.name} / ${mine?.refCode}`);
  check('  …the verified mobile comes from where it is WRITTEN, not from a second copy',
    mine?.mobile === '447700900333' && !!mine?.mobileVerifiedAt,
    'TwoFactorSecret, which confirmPhoneVerification writes and nothing else does');
  check('  …the email is shown as unverified, because nothing stamped it',
    mine?.emailVerifiedAt === null, 'the link being followed is what stamps it, and nobody followed one here');
  check('  …both garages they introduced are listed, with status and whether they ever paid',
    mine?.garages.length === 2 && mine.garages.every((g) => typeof g.status === 'string' && g.everPaid === false),
    `${mine?.garages.map((g) => `${g.name}:${g.status}`).join(', ')}`);
  check('  …and the money is the LEDGER summed, not a stored figure',
    mine?.earnedPennies === 6000,
    `${mine?.earnedPennies}p — two accruals of £30, net of nothing`);
  // THE HOLD, WHICH IS THE FIRST READER rewardIsPayable HAS EVER HAD. Both accruals above were
  // written just now, so both are inside the 14 days and NOTHING is payable yet.
  check('  …with nothing payable yet, because the hold has not run',
    mine?.payablePennies === 0 && mine?.heldPennies === 6000,
    `payable ${mine?.payablePennies}p, held ${mine?.heldPennies}p — ${ADMIN.HOLD_DAYS} days from each payment`);
  const matured = await ADMIN.listAffiliates(prisma, new Date(Date.now() + (ADMIN.HOLD_DAYS + 1) * 86400000));
  check('  …and it IS payable once the hold has run',
    matured.find((a) => a.id === aff.id)?.payablePennies === 6000,
    'the same rows read at a later instant — the hold is derived, not a column somebody flips');

  // ── 4. THE WRITER ────────────────────────────────────────────────────────────────────────────
  console.log('\n— suspend and unsuspend —');
  const first = await ADMIN.setSuspended(prisma, { affiliateId: aff.id, suspended: true, at: SUSPENDED_ON });
  check('suspending records the moment', first.ok === true && first.suspendedAt?.getTime() === SUSPENDED_ON.getTime());
  const twice = await ADMIN.setSuspended(prisma, { affiliateId: aff.id, suspended: true });
  check('  …and suspending again does NOT move the date',
    twice.ok === true && twice.suspendedAt?.getTime() === SUSPENDED_ON.getTime(),
    '"earns nothing from that moment" must not mean "from the last time anybody clicked"');
  const un = await ADMIN.setSuspended(prisma, { affiliateId: aff.id, suspended: false });
  check('  …unsuspending clears it', un.ok === true && un.suspendedAt === null);
  const rep = await prisma.rep.create({ data: { party_type: 'rep', email: 'zzad-rep@example.invalid', name: `${PREFIX} Reseller`, ref_code: `${PREFIX}REP1` }, select: { id: true } });
  const wrongParty = await ADMIN.setSuspended(prisma, { affiliateId: rep.id, suspended: true });
  check('  …and a RESELLER cannot be suspended from here',
    wrongParty.ok === false && /reseller/i.test(wrongParty.message),
    'one endpoint quietly governing both arrangements would make this button mean two things');

  // ── 5. AND THE OPERATOR CAN SEE AND DO IT ────────────────────────────────────────────────────
  console.log('\n— through the real Engine Room —');
  const before = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { affiliate_joining_open: true } });
  joiningBefore = before?.affiliate_joining_open ?? false;
  const op = await prisma.operator.create({ data: {
    email: OP_EMAIL, name: 'Affiliate admin gate', role: 'owner', status: 'active',
    regions: ['GB'], passwordHash: await bcrypt.hash(OP_PASS, 10) }, select: { id: true } });
  browser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 2200 } })).newPage();
  const onLogin = (p) => underPath(p, '/superadmin/login');
  await page.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', OP_EMAIL);
  await page.fill('input[type="password"]', OP_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !onLogin(u.pathname), { timeout: 60000 }).catch(() => {});
  check('an owner operator is signed in', !onLogin(new URL(page.url()).pathname), page.url());

  await page.goto(`${ER}/superadmin/affiliates`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-list"]', { timeout: 30000 }).catch(() => {});
  const inDb = (await ADMIN.listAffiliates(prisma)).length;
  const onScreen = await page.locator('[data-testid="affiliate-row"]').count();
  check('every affiliate in the table is on the screen', onScreen === inDb && onScreen > 0, `${onScreen} rows, ${inDb} affiliates`);
  const row = page.locator('[data-testid="affiliate-row"]', { hasText: `${PREFIX} Affiliate` });
  const rowText = await row.innerText().catch(() => '');
  // EACH VERIFICATION ASKED BY NAME, not matched out of the row's text. The component carries its
  // own testid for exactly this: a regex over the whole row would also match the other
  // verification's words, and anchored-match-gate rightly bans that shape anyway.
  const sms = await row.locator('[data-testid="verified-sms"]').innerText().catch(() => '');
  const mail = await row.locator('[data-testid="verified-email"]').innerText().catch(() => '');
  check('  …with the code, the joined date and both verifications',
    rowText.includes(`${PREFIX}CODE1`) && sms.trim() === 'SMS: yes' && mail.trim() === 'Email: no',
    `${sms.trim()} / ${mail.trim()} — the word, not a tick: a tick and a blank cell read the same`);
  check('  …the garages it introduced, and their status',
    /Garages referred \(2\)/.test(rowText) && rowText.includes(`${PREFIX} garage 1`),
    'named only as much as an operator needs — the name, the ref and the status');
  check('  …and the money, as earned, payable and held',
    /Earned £60\.00/.test(rowText) && /Payable £0\.00/.test(rowText) && /held £60\.00/.test(rowText),
    rowText.replace(/\s+/g, ' ').match(/Earned[^·]*·[^·]*/)?.[0] ?? '');

  // PRESS IT. The dialog is accepted rather than suppressed: the confirmation is part of the
  // control, and a clause that bypassed it would be about an endpoint rather than a button.
  page.once('dialog', (d) => d.accept());
  // THE ENDPOINT'S OWN ANSWER, captured as the page gets it. `changed` is what decides whether an
  // audit row is written, so a clause about the audit that cannot see it is a clause guessing why.
  const suspendResponse = page.waitForResponse((r) => urlUnder(r.url(), '/api/superadmin/affiliates'), { timeout: 30000 });
  await row.locator('[data-testid="affiliate-suspend"]').click();
  const suspendBody = await (await suspendResponse).json().catch(() => ({}));
  await page.waitForSelector('[data-testid="affiliate-suspended-badge"]', { timeout: 30000 }).catch(() => {});
  check('  …and the endpoint reports it as a CHANGE, which is what earns an audit row',
    suspendBody.ok === true && suspendBody.changed === true,
    JSON.stringify({ ok: suspendBody.ok, changed: suspendBody.changed, suspendedAt: suspendBody.suspendedAt }));
  check('pressing Suspend suspends them',
    !!(await prisma.rep.findUnique({ where: { id: aff.id }, select: { suspended_at: true } }))?.suspended_at,
    'read back from the database, not from the screen that asked for it');
  const afterText = await page.locator('[data-testid="affiliate-row"]', { hasText: `${PREFIX} Affiliate` }).innerText().catch(() => '');
  check('  …and the screen SAYS what that did',
    /no new referrals/i.test(afterText) && /nothing earns/i.test(afterText) && /keep their/i.test(afterText),
    'the three consequences and the one non-consequence, on the row it happened to');
  // NOT SCOPED TO THIS OPERATOR'S ID. The first version was, and reported `undefined — undefined`
  // while the endpoint was answering changed:true and the write itself worked when run by hand —
  // so the clause was asking the wrong question and the detail could not say which. Scoped to the
  // AFFILIATE instead, which is the subject of the row and is what an operator would search for.
  const audits = await prisma.superAdminAudit.findMany({
    where: { action: 'affiliate_suspension' },
    orderBy: { created_at: 'desc' }, take: 5,
    select: { operator_user_id: true, target_name_snapshot: true, target_ref_snapshot: true },
  });
  const audit = audits.find((a) => a.target_name_snapshot.includes(`${PREFIX}CODE1`));
  check('  …and it is audited, naming the affiliate and the direction',
    !!audit && /suspended/.test(audit.target_ref_snapshot ?? ''),
    audit ? `${audit.target_name_snapshot} — ${audit.target_ref_snapshot}` : `no row for ${PREFIX}CODE1 among ${audits.length}: ${JSON.stringify(audits).slice(0, 180)}`);
  check('  …by the operator who pressed it',
    audit?.operator_user_id === op.id,
    `${audit?.operator_user_id} vs ${op.id} — the acting operator, from the session and not from the body`);

  page.once('dialog', (d) => d.accept());
  await page.locator('[data-testid="affiliate-row"]', { hasText: `${PREFIX} Affiliate` }).locator('[data-testid="affiliate-unsuspend"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="affiliate-suspended-badge"]'), null, { timeout: 30000 }).catch(() => {});
  check('and pressing Unsuspend puts it back',
    (await prisma.rep.findUnique({ where: { id: aff.id }, select: { suspended_at: true } }))?.suspended_at === null);

  // AND IT IS OWNER-ONLY. erMinRole falls back to 'support' for an unregistered href, so this is
  // also the clause that proves the nav line exists.
  const { erMinRole } = await import('../lib/operator-roles.ts');
  check('the screen is registered as OWNER-only',
    erMinRole('/superadmin/affiliates') === 'owner',
    'an unregistered href falls back to support, which would open names, emails and mobiles to the lowest role');

} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row', left >= 0, `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
