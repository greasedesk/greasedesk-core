/**
 * File: scripts/demo-lifecycle-gate.mjs
 * Does the demo clock delete the right tenant and only the right tenant?
 *
 * Three throwaway demos, differing ONLY in their expiry:
 *   EXPIRED   demo_expires_at yesterday      → must be purged
 *   IMMORTAL  demo_expires_at NULL           → must be untouched, whatever its age
 *   LIVE      demo_expires_at in three days  → must be untouched, and must not be emailed yet
 * plus a NON-DEMO tenant with an expiry set, which must be invisible to the sweep entirely.
 *
 * The immortal one is given a creation date a year in the past, because "old" is exactly what a
 * careless predicate would delete on.
 *
 * ── TWO STANDING RULES, BOTH LEARNED BY DELETING THE WRONG THING ───────────────────────────────
 * The first version of this gate proved it "could fail" by sabotaging the real safety predicate and
 * running the real cron over the real purgeTenant on production. The reference demo tenant had a
 * null expiry by design, so it was deleted. Unrecoverable, and entirely avoidable.
 *
 *   1. FAILURE IS PROVED AGAINST THE PURE FUNCTION. demoLifecycle and isPurgeable are pure, so a
 *      deliberately-broken copy can be checked with no database and no blast radius. What is being
 *      proved is that the ASSERTIONS DISCRIMINATE — a property of the assertions, not of deletion.
 *
 *   2. THE END-TO-END SWEEP REFUSES unless its own fixtures are the only candidates in scope. The
 *      check is at the top, before anything is written, and it is the script's job rather than the
 *      operator's memory: a sweep's blast radius is whatever its predicate matches at the moment it
 *      runs, and that set changes without the script knowing.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
import { createServer } from 'node:http';
import bcrypt from 'bcryptjs';
const { prisma } = await import('../lib/db.ts');
const handler = (await import('../pages/api/cron/demo-lifecycle.ts')).default;
const { demoLifecycle, isPurgeable } = await import('../lib/demo-lifecycle.ts');

const stamp = process.env.GATE_STAMP ?? 'x';
const SECRET = process.env.CRON_SECRET || 'gate-secret';
process.env.CRON_SECRET = SECRET;

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const DAY = 86_400_000;
const made = [];

async function tenant(label, { isDemo, expiresAt, createdAt }) {
  const email = `demo-life-${label}-${stamp}@example.com`;
  const g = await prisma.group.create({
    data: {
      group_name: `ZZ Demo Life ${label} ${stamp}`, country_code: 'GB', billing_email: email,
      is_internal: true, is_demo: isDemo, demo_expires_at: expiresAt,
      ...(createdAt ? { created_at: createdAt } : {}),
    },
    select: { id: true },
  });
  const u = await prisma.user.create({
    data: { email, name: `${label} owner`, role: 'ADMIN', is_owner: true, group_id: g.id, passwordHash: await bcrypt.hash('x', 4) },
    select: { id: true },
  });
  made.push({ groupId: g.id, userId: u.id, label, email });
  return g.id;
}

/** Invoke the handler in-process with a fake req/res — no server, no network. */
async function runCron(dryRun) {
  const req = { method: 'GET', headers: { authorization: `Bearer ${SECRET}` }, query: dryRun ? { dryRun: '1' } : {} };
  let payload = null, status = 0;
  const res = {
    setHeader() {}, status(c) { status = c; return this; },
    json(b) { payload = b; return this; }, end() { return this; },
  };
  await handler(req, res);
  return { status, payload };
}

// ── RULE 1: DOES THIS GATE'S RULE-CHECK ACTUALLY DISCRIMINATE? (pure, no database) ─────────────
// A local copy of the predicate broken in the exact way that cost a tenant: null read as expired.
const BROKEN = (g, now = new Date()) => {
  if (!g?.is_demo) return false;
  if (!g.demo_expires_at) return true;                 // ← THE BUG, reproduced deliberately
  return new Date(g.demo_expires_at).getTime() <= now.getTime();
};
{
  const nullExpiry = { is_demo: true, demo_expires_at: null };
  check('RULE 1 — the real predicate spares a null expiry', isPurgeable(nullExpiry) === false);
  check('RULE 1 — and the check would CATCH the broken one', BROKEN(nullExpiry) === true,
    'a sabotaged predicate deletes it; the assertion above goes red — proved without touching a row');
}

/**
 * ── DECLARED OUT OF SCOPE ───────────────────────────────────────────────────────────────────────
 * Rule 2 below refuses on ANY demo tenant this gate did not create. That is deliberately broader
 * than the sweep's real candidate set (is_demo AND a non-null expiry IN THE PAST), and it stays
 * broad: narrowing it on `demo_expires_at` would mean trusting the exact field whose misreading
 * once deleted the reference demo — the incident recorded at the top of this file.
 *
 * So the reference demo is taken out of scope BY IDENTITY, here, in source. Not by a column.
 *
 * WHY NOT A FLAG ON Group. A flag that exempts a tenant from purging is a flag that can SILENCE
 * THIS GUARD from the direction the guard is watching: set it wrongly, or broadly, and the refusal
 * stops firing while the blast radius grows. Declare, don't infer — but never put the declaration
 * where the guarded thing can reach it. Widening this list requires a commit and a review.
 *
 * THREE CONDITIONS, so the declaration cannot rot:
 *   1. Every exclusion applied is PRINTED. An exclusion is never silent.
 *   2. It is conditional on the FACTS THAT JUSTIFY IT — still a demo, still no expiry, still
 *      internal. Give the reference demo an expiry and it becomes a real lifecycle participant:
 *      the exclusion stops applying and the gate refuses again, which is correct.
 *   3. A STALE ENTRY IS A FAILURE, not a pass. The sales demo is rebuilt periodically, so a
 *      hardcoded id goes stale by design; a dead entry must go red rather than quietly excluding
 *      nothing.
 */
const DECLARED_OUT_OF_SCOPE = [
  {
    id: '70b802d9-ed8d-41c1-b16c-55baf052a8ea',
    ref: 'GB-GD2236',
    why: 'frozen reference demo — a fixture with a job, not a lifecycle participant',
  },
];

try {
  // ── RULE 2: NOTHING ELSE MAY BE IN SCOPE ─────────────────────────────────────────────────────
  // The sweep purges by `is_demo` + an expiry in the past. If any demo exists that this script did
  // not create, its blast radius is larger than its fixtures and it must not run.
  const preExisting = await prisma.group.findMany({
    where: { is_demo: true },
    select: { id: true, group_name: true, ref: true, demo_expires_at: true, is_demo: true, is_internal: true },
  });

  // CONDITION 3 first: a declaration that no longer names anything is a broken declaration.
  const excludedIds = new Set();
  for (const d of DECLARED_OUT_OF_SCOPE) {
    const row = await prisma.group.findUnique({
      where: { id: d.id },
      select: { id: true, group_name: true, ref: true, is_demo: true, is_internal: true, demo_expires_at: true },
    });
    if (!row) {
      check(`declared exclusion ${d.ref} still exists`, false,
        'STALE — the tenant is gone (regenerated?). Update DECLARED_OUT_OF_SCOPE; a dead entry must not pass silently');
      continue;
    }
    // CONDITION 2: the exclusion holds only while the facts behind it hold.
    const justified = row.is_demo === true && row.demo_expires_at === null && row.is_internal === true;
    check(`declared exclusion ${d.ref} is still justified`, justified,
      justified
        ? `${row.group_name} — demo, no expiry, internal`
        : `NOT excluded: is_demo=${row.is_demo} expires=${row.demo_expires_at ?? 'never'} internal=${row.is_internal} — it is a lifecycle participant now`);
    if (justified) {
      excludedIds.add(row.id);
      // CONDITION 1: never silent.
      console.log(`   ↳ out of scope by declaration: ${row.group_name} (${row.ref})  — ${d.why}`);
    }
  }

  const inScope = preExisting.filter((g) => !excludedIds.has(g.id));
  if (inScope.length) {
    console.log('\nREFUSING TO RUN — demo tenants exist that this gate did not create:');
    for (const g of inScope) console.log(`   ${g.group_name}  expires=${g.demo_expires_at ?? 'never'}  ${g.id}`);
    if (excludedIds.size) {
      console.log(`\n(${excludedIds.size} tenant(s) were declared out of scope and are not listed above.)`);
    }
    console.log('\nThe sweep would have them in scope. Purge or park them first, then re-run.');
    await prisma.$disconnect();
    process.exit(2);
  }

  const expiredId = await tenant('expired', { isDemo: true, expiresAt: new Date(Date.now() - DAY) });
  const immortalId = await tenant('immortal', { isDemo: true, expiresAt: null, createdAt: new Date(Date.now() - 365 * DAY) });
  const liveId = await tenant('live', { isDemo: true, expiresAt: new Date(Date.now() + 3 * DAY) });
  const finalId = await tenant('final', { isDemo: true, expiresAt: new Date(Date.now() + 0.5 * DAY) });
  const notDemoId = await tenant('notdemo', { isDemo: false, expiresAt: new Date(Date.now() - 30 * DAY) });

  // ── THE RULE ITSELF, before the endpoint ─────────────────────────────────────────────────────
  const now = new Date();
  check('an expiry in the past is purgeable', isPurgeable({ is_demo: true, demo_expires_at: new Date(Date.now() - DAY) }, now));
  check('a NULL expiry is never purgeable', !isPurgeable({ is_demo: true, demo_expires_at: null }, now));
  check('a non-demo with an old expiry is never purgeable', !isPurgeable({ is_demo: false, demo_expires_at: new Date(Date.now() - 30 * DAY) }, now));
  check('a null expiry reports phase none, not expired', demoLifecycle({ is_demo: true, demo_expires_at: null }, now).phase === 'none');
  check('three days out is a warning, not a purge', demoLifecycle({ is_demo: true, demo_expires_at: new Date(Date.now() + 3 * DAY) }, now).phase === 'live');
  check('half a day out is final (the email day)', demoLifecycle({ is_demo: true, demo_expires_at: new Date(Date.now() + 0.5 * DAY) }, now).phase === 'final');

  // ── DRY RUN FIRST: it must name the victim and write nothing ─────────────────────────────────
  const dry = await runCron(true);
  const stillThere = await prisma.group.count({ where: { id: expiredId } });
  check('dry run names the expired tenant', JSON.stringify(dry.payload?.purged ?? []).includes('expired'), JSON.stringify(dry.payload?.purged));
  check('dry run deletes NOTHING', stillThere === 1);

  // ── THE REAL SWEEP ───────────────────────────────────────────────────────────────────────────
  const run = await runCron(false);
  console.log(`\n   cron: ${JSON.stringify(run.payload?.purged)} purged, ${JSON.stringify(run.payload?.emailed)} emailed\n`);

  check('the EXPIRED demo is gone', (await prisma.group.count({ where: { id: expiredId } })) === 0);
  check('the IMMORTAL demo survives, a year old and no expiry', (await prisma.group.count({ where: { id: immortalId } })) === 1);
  check('the LIVE demo survives', (await prisma.group.count({ where: { id: liveId } })) === 1);
  check('the FINAL demo survives — it is emailed, not deleted', (await prisma.group.count({ where: { id: finalId } })) === 1);
  check('the NON-DEMO tenant is untouched despite an expiry 30 days old', (await prisma.group.count({ where: { id: notDemoId } })) === 1);

  // ── THE EMAIL ────────────────────────────────────────────────────────────────────────────────
  const mail = await prisma.notificationLog.findFirst({
    where: { group_id: finalId, template: 'demo_expiring' },
    select: { recipient: true, status: true, error: true },
  });
  check('the final-day tenant was emailed', !!mail, mail ? `${mail.recipient} (${mail.status})` : 'no row');
  check('the email went to the OWNER, through the demo-block exception',
    !!mail && mail.recipient.includes('final') && !/demo tenant/i.test(mail.error ?? ''),
    mail ? `${mail.recipient} err=${mail.error ?? 'none'}` : '—');

  // ── IDEMPOTENT: a second sweep must not email again ──────────────────────────────────────────
  const run2 = await runCron(false);
  const mailCount = await prisma.notificationLog.count({ where: { group_id: finalId, template: 'demo_expiring' } });
  check('a second sweep does not email twice', mailCount === 1, `${mailCount} rows`);
  check('a second sweep purges nothing new', (run2.payload?.purged ?? []).length === 0, JSON.stringify(run2.payload?.purged));

  // ── AUTH ─────────────────────────────────────────────────────────────────────────────────────
  let unauth = null;
  await handler({ method: 'GET', headers: {}, query: {} }, {
    setHeader() {}, status(c) { unauth = c; return this; }, json() { return this; }, end() { return this; },
  });
  check('the endpoint refuses without the cron secret', unauth === 401, String(unauth));
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
  console.error(e);
} finally {
  for (const m of made) {
    await prisma.notificationLog.deleteMany({ where: { group_id: m.groupId } }).catch(() => {});
    await prisma.user.delete({ where: { id: m.userId } }).catch(() => {});
    await prisma.group.delete({ where: { id: m.groupId } }).catch(() => {});
  }
  const leftover = await prisma.group.count({ where: { group_name: { startsWith: `ZZ Demo Life` } } });
  console.log(`\nfixtures left: ${leftover}`);
  console.log(`${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
