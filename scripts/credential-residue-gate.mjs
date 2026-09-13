/**
 * File: scripts/credential-residue-gate.mjs
 * @gate-requires: db, server
 * THE SUITE LEAVES NO LIVE CREDENTIAL BEHIND. One clause about the whole class, because the three
 * gates that caused this were not special and the next one will not be either.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────────────────────────
 * trading-name-gate, notify-scope-gate and send-outcome-gate POST /api/invoice-sms. The ENDPOINT
 * mints the magic link — with the customer's own phone on it — and never returns its id, so none of
 * the three had anything to tear down and none of them tried. All three reported green while ZZ
 * accumulated 105 LIVE pay credentials between 30 August and 12 September, one per suite run, each
 * good for fourteen days. Every individual gate was correct. The litter belonged to nobody.
 *
 * Revoking one by hand was not a fix, and nor is revoking a hundred: the next run makes another. The
 * fix is in three parts, and this file is the third —
 *   1. trackCredentials() in _gate-preflight: photograph the tenant's links, remove what is new BY ID;
 *   2. the runner attributes a rise to the gate that caused it, so a future offender is named rather
 *      than hunted (scripts/gates.mjs, the LITTER line);
 *   3. THIS, which says the invariant out loud and fails when it stops holding.
 *
 * ── WHY "ON ZZ" IS THE RIGHT SCOPE AND NOT A WEAKENING ──────────────────────────────────────────
 * Real tenants hold live pay links all the time — that is what the feature is. ZZ is the standing
 * internal gate tenant: nobody is waiting to pay a ZZ invoice, so a live credential there is always
 * either a gate mid-run or a gate's litter. The suite is sequential (gates.mjs awaits each child), so
 * when this runs nothing else is holding one.
 *
 * A USED link is never litter and is excluded by the predicate, not by an exception list: it is
 * evidence that something happened, and a teardown that deletes evidence is worse than one that
 * leaves rubbish.
 */
import './_gate-preflight.mjs';
const { gatePrisma, trackCredentials, describeError, ZZ_GROUP, gateOrigin } = await import('./_gate-preflight.mjs');
const { readFileSync: readSrc } = await import('node:fs');
import './_ts.mjs';
const { createMagicLink } = await import('../lib/magic-link.ts');
const { hasKey } = await import('../lib/anchored-match.ts');

// THE TENANT ID LIVES IN ONE PLACE. _gate-preflight exports it; a gate spelling the UUID again is a
// second place for it to be wrong, and this gate DELETES rows — the wrong id here is the worst kind.
const ZZ = ZZ_GROUP;
let prisma;
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

/** THE PREDICATE, once. A credential is LIVE when a person holding the token could still use it. */
const liveWhere = () => ({
  group_id: ZZ, revoked_at: null, consumed_at: null, expires_at: { gt: new Date() },
});

let planted = null;
try {
  prisma = await gatePrisma();
  const g = await prisma.group.findUnique({ where: { id: ZZ }, select: { ref: true, is_internal: true } });
  check('the subject is the internal gate tenant', g?.is_internal === true, `${g?.ref} is_internal=${g?.is_internal}`);

  // ── 1. THE INVARIANT ───────────────────────────────────────────────────────────────────────────
  console.log('\n— no live credential at rest —');
  const live = await prisma.customerMagicLink.findMany({
    where: liveWhere(),
    select: { id: true, purpose: true, created_at: true, expires_at: true },
    orderBy: { created_at: 'asc' },
  });
  // THE NUMBER IS PRINTED WHETHER OR NOT IT IS ZERO. A clause that only speaks up when it fails is a
  // clause nobody looks for on a good day — and this one was silently true-by-absence for two weeks.
  console.log(`  live credentials on ${g?.ref}: ${live.length}`);
  for (const l of live.slice(0, 8)) {
    console.log(`    ${l.created_at.toISOString()}  ${l.purpose}  expires ${l.expires_at.toISOString().slice(0, 10)}`);
  }
  check('the gate tenant holds no live credential', live.length === 0,
    live.length
      ? `${live.length} left behind — oldest ${live[0].created_at.toISOString()}; a gate minted these and did not remove them`
      : 'every gate that minted one took it away again');

  // ── 2. AND THE CHECK CAN SEE ONE ───────────────────────────────────────────────────────────────
  // "Zero" means nothing until this finds a planted case: the same predicate against a credential
  // that genuinely exists. Without this, a typo in liveWhere() reads exactly like a tidy suite.
  console.log('\n— and zero means zero: a planted credential IS seen —');
  const card = await prisma.jobCard.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  if (!card) throw new Error('no ZZ job card to bind a planted link to');
  const link = await createMagicLink({
    groupId: ZZ, jobCardId: card.id, purpose: 'quote_view',
    recipient: 'credential-residue-gate@zzgategarage.test',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  planted = link.id;
  const seen = await prisma.customerMagicLink.count({ where: { ...liveWhere(), id: planted } });
  check('the predicate finds a live credential when there is one', seen === 1,
    'the discriminator — otherwise a broken predicate and a clean tenant look identical');

  // …and each of the three states that make it NOT live is the predicate's own, one at a time.
  for (const [label, data] of [
    ['revoked', { revoked_at: new Date(), revoked_reason: 'credential-residue-gate probe' }],
    ['consumed', { revoked_at: null, revoked_reason: null, consumed_at: new Date() }],
    ['expired', { consumed_at: null, expires_at: new Date(Date.now() - 1000) }],
  ]) {
    await prisma.customerMagicLink.update({ where: { id: planted }, data });
    const n = await prisma.customerMagicLink.count({ where: { ...liveWhere(), id: planted } });
    check(`  …and a ${label} one is NOT live`, n === 0, `${n} — each state is tested on its own, so no single one carries the clause`);
  }

  // ── 3. THE TRACKER ITSELF, ON A REAL MINT ──────────────────────────────────────────────────────
  // The helper the offending gates now use. Proved here rather than trusted: it is the thing standing
  // between the suite and another hundred credentials.
  console.log('\n— trackCredentials removes what it did not snapshot —');
  const creds = await trackCredentials(prisma, ZZ);
  const fresh = await createMagicLink({
    groupId: ZZ, jobCardId: card.id, purpose: 'quote_view',
    recipient: 'credential-residue-gate-tracked@zzgategarage.test',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const before = await prisma.customerMagicLink.count({ where: { ...liveWhere(), id: fresh.id } });
  const rel = await creds.release();
  const after = await prisma.customerMagicLink.count({ where: { id: fresh.id } });
  check('a link minted after the snapshot is live until released', before === 1);
  check('  …and release() removes it', after === 0 && rel.deleted === 1, rel.detail);
  check('  …and says the tenant is clean afterwards', rel.ok === true, rel.detail);

  // AND IT DOES NOT TOUCH WHAT IT DID NOT MINT. The failure that matters: a sweep by timestamp would
  // take a link another process created during the run. This one works from ids it has seen.
  const creds2 = await trackCredentials(prisma, ZZ);
  const older = await createMagicLink({
    groupId: ZZ, jobCardId: card.id, purpose: 'quote_view',
    recipient: 'credential-residue-gate-outsider@zzgategarage.test',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  // creds3 snapshots WITH `older` already present, so `older` is not its to remove.
  const creds3 = await trackCredentials(prisma, ZZ);
  const rel3 = await creds3.release();
  const survived = await prisma.customerMagicLink.count({ where: { id: older.id } });
  check('a credential present at snapshot time is NOT removed', survived === 1 && rel3.deleted === 0,
    `${rel3.detail} — scoped to ids it has seen, never to a time window`);
  const rel2 = await creds2.release();        // creds2 predates `older`, so this is what removes it
  check('  …but the tracker that predates it does remove it', rel2.deleted === 1 && (await prisma.customerMagicLink.count({ where: { id: older.id } })) === 0,
    rel2.detail);

  // ── 4. THE CAUSE, NOT THE SYMPTOM ──────────────────────────────────────────────────────────────
  // The 105 credentials were never the gates' fault. /api/invoice-sms mints the pay link, attempts
  // the send, and on failure answers "Nothing was sent." WITHOUT the url — leaving a live credential
  // reachable from nowhere but this table. Every suite run made one; so did every failed text a real
  // garage ever sent. Driven against the REAL endpoint in its REAL refusing state: this machine has
  // no SMS provider, so the refusal is genuine and needs no fixture to simulate it.
  console.log('\n— a send that does not happen leaves no credential —');
  const invoice = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'issued', series: 'chargeable', lines: { some: {} } },
    select: { id: true }, orderBy: { created_at: 'desc' },
  });
  if (!invoice) throw new Error('no issued ZZ invoice with lines to text');
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const ck = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf = await fetch(`${gateOrigin()}/api/auth/csrf`); keep(csrf);
  keep(await fetch(`${gateOrigin()}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: ck() },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken: (await csrf.json()).csrfToken, json: 'true' }),
  }));
  const watch = await trackCredentials(prisma, ZZ);
  const smsRes = await fetch(`${gateOrigin()}/api/invoice-sms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: ck() },
    body: JSON.stringify({ invoiceId: invoice.id }),
  });
  const smsBody = await smsRes.json().catch(() => ({}));
  check('the text is refused in this environment', smsRes.status === 409 || smsRes.status === 502,
    `HTTP ${smsRes.status} ${smsBody.code} — a REAL refusal, not a simulated one`);
  check('  …and the refusal hands back no url', !('url' in smsBody) && !('link' in smsBody),
    'this is the test for whether a failed send may keep its link: nobody can reach what is not returned');
  const orphans = await prisma.customerMagicLink.findMany({
    where: { ...liveWhere(), id: { notIn: [...watch.before] } },
    select: { id: true, purpose: true },
  });
  check('  …and the credential it minted is NOT live', orphans.length === 0,
    orphans.length ? `${orphans.length} orphan(s): ${orphans.map((o) => o.purpose).join(', ')} — minted for a message that never left` : 'revoked as unsent');
  // IT IS REVOKED, NOT MISSING. The row is the record that a send was attempted, and the reason says so.
  const minted = await prisma.customerMagicLink.findMany({
    where: { group_id: ZZ, id: { notIn: [...watch.before] } },
    select: { id: true, revoked_at: true, revoked_reason: true },
  });
  check('  …it is REVOKED, with the reason on the row', minted.length === 1 && minted[0].revoked_at !== null && minted[0].revoked_reason === 'unsent',
    minted.length ? `${minted.length} row, reason=${minted[0].revoked_reason}` : 'no row at all — a deleted row cannot say a send was attempted');
  const cleanup = await watch.release();
  check('  …and this gate takes its own probe away', cleanup.ok || cleanup.deleted >= 0, cleanup.detail);

  // THE DISCRIMINATOR, AND IT IS THE WHOLE POINT. quote-send and intake-report-send return the url on
  // a failed send ON PURPOSE — "the link below still works" — so an operator can hand it over. Revoking
  // THERE would delete value the product promises. A blanket "retire every link whose send failed"
  // would have broken both, which is why the rule is about what the caller is given, not about failure.
  const quoteSrc = readSrc('pages/api/quote-send.ts', 'utf8');
  const intakeSrc = readSrc('pages/api/intake-report-send.ts', 'utf8');
  check('the paths that DO hand back a url are left alone', !/revokeMagicLink\([^)]*'unsent'/.test(quoteSrc)
    && !/revokeMagicLink\([^)]*'unsent'/.test(intakeSrc),
    'a failed quote text keeps its link deliberately — the rule is "was the url returned", not "did the send fail"');
  check('  …and they really do return it', hasKey(quoteSrc, 'url') && hasKey(intakeSrc, 'url'),
    'named, so the exemption above rests on something checked rather than on my memory of these files');

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  // prisma may be undefined if gatePrisma() itself threw; a teardown that throws hides the real error.
  if (prisma && planted) {
    const d = await prisma.customerMagicLink.deleteMany({ where: { id: planted, group_id: ZZ } });
    check('teardown removed the planted credential', d.count === 1, 'by its own id, on ZZ only');
  }
  if (prisma) {
    const left = await prisma.customerMagicLink.count({ where: liveWhere() });
    check('and this gate leaves the tenant as it found it', left === 0, `${left} live credential(s)`);
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
