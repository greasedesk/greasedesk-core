/**
 * File: scripts/photo-partition-gate.mjs
 * A photo outside its tenant partition would SURVIVE A PURGE THAT REPORTED SUCCESS.
 *
 * ── THIS IS A DELETION-GUARANTEE PROBLEM, NOT A NULLABLE COLUMN ─────────────────────────────────
 * JobCardPhoto.group_id is the tenant partition AND the first segment of the R2 object key. The
 * SuperAdmin purge deletes objects by the prefix `{group_id}/`. `photoKey` used to sanitise with
 * `(s || '')`, so an absent group produced an EMPTY first segment and the object landed at the
 * bucket root — outside every partition, and therefore outside the purge's scope.
 *
 * The purge would still have come back "successful". If a garage exercised an erasure request we
 * would have told them their data was destroyed and it would not have been.
 *
 * ── WHAT IS PROVED, AND HOW ─────────────────────────────────────────────────────────────────────
 *   1. photoKey REFUSES a missing tenant instead of defaulting to a rootward path;
 *   2. a rootward key genuinely is invisible to the purge's matching rule — proved against the
 *      PURE PREDICATE, never against a real purge (a destructive path is not a test fixture);
 *   3. the row cannot exist: the column is NOT NULL and Postgres refuses;
 *   4. every photo that exists TODAY is inside its own tenant's partition — the real data, not a
 *      fixture, because the question "did this already happen?" is not answered by a synthetic row.
 *
 * No R2 calls: R2 is unconfigured here, and the matching rule is what determines survival anyway.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { photoKey, R2KeyError, tenantPrefix, isInsideTenantPartition } = await import('../lib/r2.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const CARD = '11111111-2222-3333-4444-555555555555';

try {
  // ── 1. IT REFUSES, IT DOES NOT DEFAULT ─────────────────────────────────────────────────────
  console.log('\n— photoKey refuses a missing tenant —');
  for (const [label, gid] of [['undefined', undefined], ['null', null], ['empty string', ''], ['whitespace', '   '], ['punctuation only', '///']]) {
    let err = null;
    try { photoKey(gid, CARD, 'intake', 'vin', 'p1', 'jpg'); } catch (e) { err = e; }
    check(`a ${label} tenant is REFUSED`, err instanceof R2KeyError && err.code === 'r2_key_unsafe',
      err ? `${err.name}` : 'NO THROW — it built a key with an empty first segment');
  }
  // The rule is not "non-empty" — it is "unchanged". '   ' sanitises to '___', which is non-empty
  // and still not the tenant's partition; the purge sweeps the RAW groupId, so any substitution
  // puts the object outside the range that sweeps it. The first version of this gate asserted
  // emptiness and found exactly that gap.
  check('the tenant segment must survive sanitisation UNCHANGED, not merely non-empty',
    (() => { try { photoKey('ab cd', CARD, 'intake', 'vin', 'p1'); return false; } catch (e) { return e instanceof R2KeyError; } })(),
    "'ab cd' → 'ab_cd' would be swept by no prefix anybody uses");
  check('the error explains the consequence, not just the rule', /survive a tenant purge/i.test(new R2KeyError('groupId').message),
    'whoever hits this must learn WHY a rootward key matters');
  // Discriminating: a real tenant still builds, or "refuses everything" would pass the above.
  const good = photoKey(ZZ, CARD, 'intake', 'vin', 'p1', 'jpg');
  check('the check is discriminating — a real tenant still builds a key', typeof good === 'string' && good.startsWith(`${ZZ}/`), good);
  // Every other segment too: an empty job card is just as malformed, if less dangerous.
  let cardErr = null;
  try { photoKey(ZZ, '', 'intake', 'vin', 'p1'); } catch (e) { cardErr = e; }
  check('an empty job card id is refused as well', cardErr instanceof R2KeyError);

  // ── 2. THE PURGE WOULD MISS A ROOTWARD OBJECT ──────────────────────────────────────────────
  // Against the pure matching rule. Proving a destructive gate is done against the predicate,
  // never against a real purge path — see destructive-gate-discipline.
  console.log('\n— why it mattered: the purge sweeps by prefix —');
  const rootward = `/${CARD}/intake/vin/p1.jpg`;          // what the old (s || '') produced
  const legacy = `${CARD}/intake/vin/p1.jpg`;             // same, without the leading slash
  check('a rootward key is NOT inside the tenant partition', !isInsideTenantPartition(rootward, ZZ), rootward);
  check('nor is the leading-slash-free variant', !isInsideTenantPartition(legacy, ZZ));
  check('so deleteByPrefix would never reach it', !rootward.startsWith(tenantPrefix(ZZ)) && !legacy.startsWith(tenantPrefix(ZZ)),
    `prefix "${tenantPrefix(ZZ)}" — the purge would report success and leave the object behind`);
  check('a correctly-built key IS inside it', isInsideTenantPartition(good, ZZ),
    'the discriminator: the rule is not simply refusing everything');
  // The purge must use the SAME rule, not its own copy of it.
  check('tenant-purge uses the shared prefix rule', /deleteByPrefix\(tenantPrefix\(groupId\)\)/.test(readFileSync('lib/tenant-purge.ts', 'utf8')),
    'two copies of a matching rule is how objects end up outside the range that sweeps them');

  // ── 3. THE ROW CANNOT EXIST ────────────────────────────────────────────────────────────────
  console.log('\n— and the row cannot exist —');
  const card = await prisma.jobCard.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  if (!card) throw new Error('no ZZ job card');
  let refused = null;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "JobCardPhoto" (id, job_card_id, group_id, stage, slot, r2_key)
       VALUES (gen_random_uuid(), $1, NULL, 'intake', 'vin', 'photo_gate_mustfail')`, card.id);
  } catch (e) { refused = String(e?.message ?? e); }
  const byNotNull = refused !== null && /23502|null value|not-null/i.test(refused);
  check('a null tenant is REFUSED by the database', byNotNull,
    refused === null ? 'THE INSERT SUCCEEDED — the column is still nullable'
      : byNotNull ? 'NOT NULL, code 23502'
        : `refused, but NOT by NOT NULL: ${refused.split('\n').filter((l) => l.trim()).pop()?.trim().slice(0, 120)}`);
  check('and nothing was written', (await prisma.jobCardPhoto.count({ where: { r2_key: 'photo_gate_mustfail' } })) === 0);

  // ── 3b. AND NEITHER CAN A KEYLESS ROW ──────────────────────────────────────────────────────
  // Narrower than the partition rule: a photo row with no key is not a leak, it is an ORPHAN —
  // an object no reader can render and no operator can find. photoKey is the only builder and it
  // refuses rather than returning something unusable, so a null here could only mean a caller
  // forgot.
  console.log('\n— nor can a row with no key —');
  let keyless = null;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "JobCardPhoto" (id, job_card_id, group_id, stage, slot, r2_key)
       VALUES (gen_random_uuid(), $1, $2, 'intake', 'vin', NULL)`, card.id, ZZ);
  } catch (e) { keyless = String(e?.message ?? e); }
  const keyByNotNull = keyless !== null && /23502|null value|not-null/i.test(keyless);
  check('a null r2_key is REFUSED by the database', keyByNotNull,
    keyless === null ? 'THE INSERT SUCCEEDED — the column is still nullable'
      : keyByNotNull ? 'NOT NULL, code 23502'
        : `refused, but NOT by NOT NULL: ${keyless.split('\n').filter((l) => l.trim()).pop()?.trim().slice(0, 120)}`);
  // Discriminating: the same insert WITH a key must succeed, or the refusal proves only that the
  // table rejects this shape for some other reason.
  let legal = true, legalId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO "JobCardPhoto" (id, job_card_id, group_id, stage, slot, r2_key)
       VALUES (gen_random_uuid(), $1, $2, 'intake', 'vin', $3) RETURNING id`, card.id, ZZ, `${ZZ}/photo_gate_ok`);
    legalId = rows[0].id;
  } catch { legal = false; }
  check('the check is discriminating — the same row WITH a key inserts', legal && !!legalId);
  if (legalId) await prisma.jobCardPhoto.delete({ where: { id: legalId } }).catch(() => {});

  // ── 4. THE REAL DATA, NOT A FIXTURE ────────────────────────────────────────────────────────
  // "Could this have happened already?" is a question about the rows that exist, and no synthetic
  // row answers it.
  console.log('\n— every photo that exists today —');
  const all = await prisma.jobCardPhoto.findMany({ select: { id: true, group_id: true, r2_key: true } });
  const strays = all.filter((p) => !p.r2_key || !isInsideTenantPartition(p.r2_key, p.group_id));
  check(`all ${all.length} photos are inside their own tenant's partition`, strays.length === 0,
    strays.length ? `\n    ${strays.map((p) => `${p.id} key=${p.r2_key ?? 'NULL'} group=${p.group_id}`).join('\n    ')}`
      : 'so no object is currently beyond the reach of a purge');
  check('and every one names a tenant', all.every((p) => !!p.group_id), `${all.length} rows`);
  check('and every one names an object', all.every((p) => !!p.r2_key), `${all.length} rows`);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await prisma.jobCardPhoto.deleteMany({ where: { r2_key: { in: ['photo_gate_mustfail', `${ZZ}/photo_gate_ok`] } } });
  check('no fixture row survives', (await prisma.jobCardPhoto.count({ where: { r2_key: 'photo_gate_mustfail' } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
