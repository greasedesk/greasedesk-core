/**
 * File: scripts/backup-run-gate.mjs
 * @gate-requires: db, server
 *
 * THE EVIDENCE A BACKUP LEAVES, AND THE SENTENCE A PERSON READS.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * Eleven consecutive nightly backups failed in September and nobody could see it. The clause this
 * gate exists for is not "a row can be written" — it is that eleven failures in a row produce a
 * sentence that says ELEVEN. A log of twenty dates where the last nineteen failed looks exactly
 * like a log of twenty dates where they succeeded, so the verdict is computed and the computation
 * is what gets tested.
 *
 * FIXTURES: BackupRun has no group_id by construction, so these rows are not tenant-scoped and the
 * screen is shared. Every fixture stamp carries the ZZGATE prefix and is swept before and after;
 * nothing here touches a row it did not create.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, gateOrigin, serverReady, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
/**
 * .env, DELIBERATELY. Gates take DATABASE_URL from the shell profile, but BACKUP_RUN_TOKEN is a
 * secret the DEV SERVER read from .env, and this gate has to present the same one to be the
 * endpoint's real caller. Reading it from anywhere else would test a different door. The value is
 * never printed — only whether it is set.
 */
await import('dotenv/config');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZGATE';
const H = (n) => new Date(Date.now() - n * 3_600_000);

let prisma; let browser = null;
try {
  const B = await import(`${R}/lib/backup-runs.ts`);
  const origin = gateOrigin();
  await serverReady(origin);
  const TOKEN = process.env.BACKUP_RUN_TOKEN;
  if (!TOKEN) declineToRun('BACKUP_RUN_TOKEN is not set, so the endpoint cannot be exercised as its only real caller does. Set it in .env and restart the dev server.');
  prisma = await gatePrisma();

  const sweep = () => prisma.backupRun.deleteMany({ where: { stamp: { startsWith: PREFIX } } });
  const swept = (await sweep()).count;
  if (swept) console.log(`  (swept ${swept} fixture run(s) from an earlier run)`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PURE — the verdict, which is the whole point
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— EVERY OUTCOME STATED —');
  check('both outcomes are accepted', B.BACKUP_OUTCOMES.every((o) => B.isBackupOutcome(o)) && B.BACKUP_OUTCOMES.length === 2, B.BACKUP_OUTCOMES.join(', '));
  check('  …and anything else is refused rather than read as success',
    !B.isBackupOutcome('ok') && !B.isBackupOutcome('') && !B.isBackupOutcome(null) && !B.isBackupOutcome('VERIFIED'),
    'ok, empty, null and the wrong case all refused');

  const row = (stamp, hoursAgo, outcome) => ({
    stamp, started_at: H(hoursAgo), finished_at: H(hoursAgo), outcome,
    failed_step: outcome === 'failed' ? 'upload to R2' : null, bytes: 1n, table_count: 118, total_rows: 9,
  });

  console.log('\n— NOTHING YET IS NOT THE SAME AS BROKEN —');
  check('no rows at all reads as "none", never as failing', B.backupHealth([], new Date()).state === 'none');
  check('  …and says the reporting itself may be the thing that is broken',
    /cannot reach this site to say so/.test(B.healthSentence({ state: 'none' })),
    'an empty table means no backup OR no report, and those need different actions');

  console.log('\n— WORKING, LATE, AND BROKEN ARE THREE DIFFERENT ANSWERS —');
  const ok = B.backupHealth([row('a', 3, 'verified'), row('b', 27, 'verified')], new Date());
  check('a verified run a few hours ago reads as ok', ok.state === 'ok' && ok.hoursSince === 3, `${ok.state} ${ok.hoursSince}h`);
  const stale = B.backupHealth([row('a', 80, 'verified')], new Date());
  check('a verified run three days ago reads as STALE, not ok', stale.state === 'stale', `${stale.state} after ${B.STALE_AFTER_HOURS}h`);
  check('  …and the sentence says something has stopped reporting', /stopped reporting/.test(B.healthSentence(stale)), B.healthSentence(stale));

  /**
   * THE ELEVEN-NIGHT CLAUSE. Consecutive failures counted from the NEWEST backwards — "how long has
   * this been broken", not "how many failures are in the table". The fixture plants a verified run
   * BEHIND the failures and two older failures behind that, so a function counting every failed row
   * would answer 5 and a function counting the wrong direction would answer 2.
   */
  console.log('\n— ELEVEN FAILURES MUST SAY ELEVEN —');
  const eleven = Array.from({ length: 11 }, (_, i) => row(`f${i}`, 1 + i * 24, 'failed'))
    .concat([row('good', 11 * 24 + 30, 'verified'), row('old1', 500, 'failed'), row('old2', 520, 'failed')]);
  const h11 = B.backupHealth(eleven, new Date());
  check('eleven consecutive failures are counted as eleven', h11.state === 'failing' && h11.consecutiveFailures === 11,
    `${h11.state} ${h11.consecutiveFailures}`);
  check('  …counted from the newest backwards, so older failures behind a good night do not inflate it',
    h11.consecutiveFailures !== 13 && h11.consecutiveFailures !== 2, '13 would be every failed row; 2 would be the wrong direction');
  check('  …and the sentence states the number, because "backup failed" reads as one night',
    /11 backups in a row have failed/.test(B.healthSentence(h11)), B.healthSentence(h11));
  check('  …and names how long ago the last good one was', /\b12 days ago\b/.test(B.healthSentence(h11)), B.healthSentence(h11));
  const never = B.backupHealth([row('f1', 2, 'failed'), row('f2', 26, 'failed')], new Date());
  check('failures with no good night ever says exactly that',
    never.state === 'failing' && never.lastVerified === null && /not one has ever been verified/.test(B.healthSentence(never)),
    B.healthSentence(never));
  check('every state except ok is shown as a problem',
    B.isBad({ state: 'none' }) && B.isBad(stale) && B.isBad(h11) && !B.isBad(ok));

  console.log('\n— WHAT THE ENDPOINT WILL ACCEPT —');
  /**
   * THE PREFIX IS NOT COSMETIC. This object is the body of the auth tests as well as the shape
   * tests, so any mutation that lets an unauthorised call through writes THIS row — and a stamp
   * without the gate prefix is one teardown never learns about. A red-proof did exactly that and
   * left a row reading as a verified backup an hour ago, which made the screen say "ok".
   * Every row this gate can possibly create must be sweepable.
   */
  const good = { stamp: `${PREFIX}-shape`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    outcome: 'verified', objectKey: 'daily/db-x.dump.gpg', bytes: 1234 };
  check('a complete verified submission is accepted', B.submissionRefusal(good) === null, B.submissionRefusal(good) ?? 'accepted');
  const bad = [
    ['no stamp', { ...good, stamp: '' }],
    ['a stamp with a slash in it', { ...good, stamp: 'daily/db' }],
    ['an unparseable startedAt', { ...good, startedAt: 'last night' }],
    ['an outcome nobody defined', { ...good, outcome: 'probably fine' }],
    ['verified with no object behind it', { ...good, objectKey: '' }],
    ['verified that never finished', { ...good, finishedAt: null }],
    ['verified with no size', { ...good, bytes: 0 }],
    ['failed with no step named', { ...good, outcome: 'failed', failedStep: '' }],
    ['a malformed digest', { ...good, sha256: 'abc' }],
  ];
  const missed = bad.filter(([, p]) => B.submissionRefusal(p) === null).map(([l]) => l);
  check(`every rule refuses its own case (${bad.length} planted)`, missed.length === 0, missed.join(', ') || `${bad.length} of ${bad.length} refused`);

  console.log('\n— THE PAYLOAD IS BUILT FROM THE MANIFEST, NOT RESTATED —');
  const man = { database: 'neondb', tables: { A: 1, B: 2, C: 0 }, totalRows: 3, migrations: 238, juneGolden: { invoices: 7, sha256: 'x' } };
  const asm = B.assembleSubmission({ stamp: 'S1', startedAt: H(1), finishedAt: new Date(), outcome: 'verified', objectKey: 'k', bytes: 9, manifest: man });
  check('the table count comes from the manifest it measured', asm.tableCount === 3 && asm.totalRows === 3 && asm.migrations === 238, `${asm.tableCount} tables`);
  check('  …the golden comparison is carried, not reduced to a verdict',
    JSON.stringify(asm.golden) === JSON.stringify(man.juneGolden), 'a later reader can disagree using tonight’s numbers');
  const empty = B.assembleSubmission({ stamp: 'S2', startedAt: H(1), outcome: 'failed', failedStep: 'dump', manifest: { tables: {}, totalRows: 0 } });
  check('  …and an EMPTY database reports zero tables, not "we did not measure"',
    empty.tableCount === 0 && empty.totalRows === 0, `${empty.tableCount} / ${empty.totalRows} — a real and alarming measurement`);
  const none = B.assembleSubmission({ stamp: 'S3', startedAt: H(1), outcome: 'failed', failedStep: 'dump', manifest: null });
  check('  …while no manifest at all reports nothing measured', none.tableCount === null && none.totalRows === null);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE ENDPOINT, AS ITS ONLY REAL CALLER REACHES IT
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— THE DOOR —');
  const post = (body, token) => fetch(`${origin}/api/backup-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const noAuth = await post(good);
  check('no credential is refused', noAuth.status === 401, `HTTP ${noAuth.status}`);
  const wrong = await post(good, `${TOKEN}x`);
  check('  …and so is the wrong one', wrong.status === 401, `HTTP ${wrong.status}`);
  const shortWrong = await post(good, 'x');
  check('  …including one of a different length, which a timing-safe compare must not throw on',
    shortWrong.status === 401, `HTTP ${shortWrong.status}`);
  const getIt = await fetch(`${origin}/api/backup-run`, { headers: { authorization: `Bearer ${TOKEN}` } });
  check('  …and only POST is answered', getIt.status === 405, `HTTP ${getIt.status}`);

  const malformed = await post({ ...good, stamp: `${PREFIX}-malformed`, outcome: 'maybe' }, TOKEN);
  const malBody = await malformed.json().catch(() => ({}));
  check('a bad shape is refused with the reason, not a 500',
    malformed.status === 400 && /outcome must be one of/.test(malBody.message ?? ''), `HTTP ${malformed.status}: ${(malBody.message ?? '').slice(0, 60)}`);
  const noRow = await prisma.backupRun.count({ where: { stamp: `${PREFIX}-malformed` } });
  check('  …and writes nothing', noRow === 0);

  const stamp = `${PREFIX}-night-1`;
  const real = B.assembleSubmission({ stamp, startedAt: H(2), finishedAt: H(1), outcome: 'verified',
    objectKey: 'daily/2026-10-11/db.dump.gpg', bytes: 48_234_567, pgVersion: 'pg18', manifest: man });
  const sent = await post(real, TOKEN);
  check('a verified night is recorded', sent.status === 200, `HTTP ${sent.status}`);
  const saved = await prisma.backupRun.findUnique({ where: { stamp } });
  check('  …with the evidence intact: size, tables, rows, migrations, the object key',
    saved?.outcome === 'verified' && saved.bytes === 48_234_567n && saved.table_count === 3
    && saved.total_rows === 3 && saved.migrations === 238 && saved.object_key === 'daily/2026-10-11/db.dump.gpg',
    `${saved?.bytes} bytes, ${saved?.table_count} tables`);
  // FIELD BY FIELD, not stringified: JSONB normalises key order, so comparing JSON.stringify of
  // the two sides compares a transformation of one against the other and fails on a correct row.
  const g = saved?.golden_json;
  check('  …and the golden comparison stored as sent',
    !!g && g.invoices === man.juneGolden.invoices && g.sha256 === man.juneGolden.sha256
    && Object.keys(g).length === Object.keys(man.juneGolden).length,
    JSON.stringify(g));

  /** A RETRIED STEP IS THE SAME NIGHT. Recorded twice it would read as two bad nights, and the
   *  health verdict counts consecutive failures — so idempotency is a correctness rule, not tidiness. */
  const retry = await post({ ...real, outcome: 'failed', failedStep: 'restore or verify', objectKey: null, bytes: null, finishedAt: null }, TOKEN);
  const afterRetry = await prisma.backupRun.findMany({ where: { stamp } });
  check('reporting the same stamp again corrects that night rather than inventing a second',
    retry.status === 200 && afterRetry.length === 1 && afterRetry[0].outcome === 'failed' && afterRetry[0].failed_step === 'restore or verify',
    `${afterRetry.length} row(s), now ${afterRetry[0]?.outcome}`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE SCREEN — the verdict has to be the loud thing
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— WHAT AN OWNER SEES —');
  /**
   * A GOOD NIGHT BEHIND THE BAD ONES. Without it every fixture is failed and the page takes the
   * "not one has ever been verified" branch — true, but the branch that matters on a live tenant is
   * the other one: it has to name BOTH how many nights are broken and how long ago it last worked.
   */
  // DERIVED, NOT WRITTEN. date-constant-gate is right to refuse a literal "11 days ago" in a gate:
  // the number belongs to the fixture, so it is computed from the fixture and the clause cannot
  // drift from it — including across a DST boundary, where a hand-written 11 becomes a 10.
  const GOOD_HOURS = 11 * 24;
  const GOOD_DAYS = Math.floor(GOOD_HOURS / 24);
  await post(B.assembleSubmission({ stamp: `${PREFIX}-good`, startedAt: H(GOOD_HOURS), finishedAt: H(GOOD_HOURS - 1),
    outcome: 'verified', objectKey: 'daily/old.dump.gpg', bytes: 1_000_000, manifest: man }), TOKEN);
  for (let i = 0; i < 4; i += 1) {
    const s2 = `${PREFIX}-fail-${i}`;
    await post(B.assembleSubmission({ stamp: s2, startedAt: H(1 + i * 24), outcome: 'failed', failedStep: 'upload to R2', manifest: man }), TOKEN);
  }
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${origin}/admin/settings/backups`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="backup-health"]', { timeout: 25000 });

  const state = await page.getAttribute('[data-testid="backup-health"]', 'data-state');
  const verdict = (await page.textContent('[data-testid="backup-health"]')) ?? '';
  check('the page leads with the verdict, not the list', state === 'failing', `data-state=${state}`);
  check('  …and the verdict names the number of failed nights AND when it last worked',
    /5 backups in a row have failed/.test(verdict)
    && new RegExp(`last one that was verified ran ${GOOD_DAYS} days ago`).test(verdict),
    verdict.trim().slice(0, 110));
  /** PAINTED, not merely present: a 0x0 element passes every geometry test. */
  const box = await page.locator('[data-testid="backup-health"]').boundingBox();
  check('  …and it is actually on the screen', !!box && box.width > 200 && box.height > 20, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'NO BOX');
  check('  …saying whose problem it is', /on us to fix, not you/.test(verdict));

  const means = (await page.textContent('[data-testid="verified-means"]')) ?? '';
  check('“verified” is explained as a restore, not an upload',
    /restored into an empty database/.test(means) && /matched the source exactly/.test(means), means.trim().slice(0, 80));

  const rows = await page.locator('[data-testid="run-row"]').count();
  check(`every reported night is listed (${rows} rows)`, rows >= 5, `${rows} listed`);
  const failedShown = await page.locator('[data-testid="run-row"][data-outcome="failed"]').count();
  check('  …and a failed night names the step that failed', failedShown >= 5 && /upload to R2/.test((await page.textContent('[data-testid="runs-table"]')) ?? ''));

  /**
   * NO RESTORE BUTTON. The whole-database dump cannot restore one garage, and a button that half
   * works is worse than an honest sentence. Asserted as the ABSENCE of a control plus the PRESENCE
   * of the explanation, because absence alone is also what a broken page looks like.
   */
  const restoreText = (await page.textContent('[data-testid="restore"]')) ?? '';
  const buttons = await page.locator('[data-testid="restore"] button, [data-testid="platform-backups"] button').count();
  check('the platform section offers no restore control at all', buttons === 0, `${buttons} button(s)`);
  check('  …and says instead that a person does it, with you', /done by hand, by us, with you/.test(restoreText), restoreText.trim().slice(0, 80));
  check('  …and says what happens to numbers already issued', /invoice numbers that have already been issued/.test(restoreText));

  const exportsText = (await page.textContent('[data-testid="your-exports"]')) ?? '';
  check('the tenant’s own copy is named as not built yet, rather than silently missing',
    /not available yet/.test(exportsText) && /being built/.test(exportsText), exportsText.trim().slice(0, 80));
  check('  …and offers a route to the data in the meantime', /contact us/.test(exportsText));
  check('  …and the platform section does not claim the backup is theirs',
    /not a file you can download or restore yourself/.test((await page.textContent('[data-testid="platform-backups"]')) ?? ''));

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const left = await prisma.backupRun.deleteMany({ where: { stamp: { startsWith: PREFIX } } });
      const remaining = await prisma.backupRun.count({ where: { stamp: { startsWith: PREFIX } } });
      check('teardown left no fixture runs behind', remaining === 0, `${left.count} removed, ${remaining} left`);
    } catch (e) { check('teardown ran', false, describeError(e).slice(0, 120)); }
    await prisma.$disconnect().catch(() => {});
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
