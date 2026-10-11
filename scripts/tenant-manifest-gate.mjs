/**
 * File: scripts/tenant-manifest-gate.mjs
 * @gate-requires: db
 *
 * WHAT A TENANT'S DATA IS — and whether the manifest still describes the schema.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * The purge sweep enumerated the awkward tables in August against 73 models. There are now 117, and
 * nobody noticed the list going stale. lib/tenant-manifest exists so that decay is a build failure
 * rather than an export that quietly omits a table — and this gate exists because the manifest's
 * own boot invariant can only check it against Prisma's DMMF, which is generated from the same file
 * the manifest was written beside. The oracle here is the DATABASE: information_schema, read
 * directly. A classification that agrees only with the schema it was copied from is not checked.
 *
 * Every rule is also planted and watched to fail, because a predicate asserted only over data that
 * happens to be correct is a predicate nobody has seen work.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';

let prisma;
try {
  prisma = await gatePrisma();
  const M = await import(`${R}/lib/tenant-manifest.ts`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE MANIFEST AS IT STANDS
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— SOUND, AND TOTAL —');
  const faults = M.auditManifest();
  check('the manifest is sound against its own invariants', faults.length === 0, faults.slice(0, 3).join(' | ') || 'no faults');
  check('every model is classified exactly once, exported or omitted',
    M.EXPORTED_MODELS.length + M.OMITTED_MODELS.length === M.SCHEMA.size,
    `${M.EXPORTED_MODELS.length} exported + ${M.OMITTED_MODELS.length} omitted = ${M.SCHEMA.size} models`);

  /**
   * THE INDEPENDENT ORACLE. information_schema is the database's own answer, read without Prisma's
   * datamodel. No model in this schema uses @@map, so a table name IS a model name; if that ever
   * changes this clause is where it surfaces, as a name in one list and not the other.
   */
  console.log('\n— AGAINST THE DATABASE, NOT AGAINST PRISMA —');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const tables = new Set(rows.map((r) => r.table_name).filter((t) => !t.startsWith('_prisma')));
  const classified = new Set([...M.EXPORTED_MODELS, ...M.OMITTED_MODELS.map((o) => o.model)]);
  const unclassifiedTables = [...tables].filter((t) => !classified.has(t));
  const phantomEntries = [...classified].filter((m) => !tables.has(m));
  check(`every table in the database is classified (${tables.size} tables)`,
    unclassifiedTables.length === 0, unclassifiedTables.join(', ') || 'none unclassified');
  check('  …and the manifest names no table that does not exist',
    phantomEntries.length === 0, phantomEntries.join(', ') || 'none phantom');

  const colsOf = async (t) => new Set((await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, t,
  )).map((r) => r.column_name));

  /**
   * THE 15 ROWS A group_id FILTER CANNOT SEE. Each names a parent; assert the DATABASE really has a
   * column joining to it. A path that exists only in the manifest's prose is the silent-omission
   * failure wearing a different hat.
   */
  console.log('\n— THE PATHS THAT ARE NOT A group_id FILTER —');
  const beyond = M.BEYOND_A_GROUP_FILTER;
  const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const pathFaults = [];
  for (const b of beyond) {
    if (b.reach.by !== 'parent') continue;
    const cols = await colsOf(b.model);
    if (!cols.has(`${snake(b.reach.through)}_id`)) pathFaults.push(`${b.model} -> ${b.reach.through}: no ${snake(b.reach.through)}_id column in the database`);
  }
  check(`every exported model beyond a group filter has a real join column (${beyond.length} of them)`,
    pathFaults.length === 0, pathFaults.join(' | ') || beyond.map((b) => b.model).join(', '));
  check('  …and none of them claims a group_id it does not have',
    beyond.every((b) => b.reach.by !== 'group'), 'reach is parent or subject, never group');

  /**
   * CREDENTIALS, ENUMERATED FROM THE SCHEMA rather than from a list of tables somebody remembered.
   * Every exported model is asked whether it holds a credential-shaped column, and if it does the
   * manifest must say that column is removed. A new reset_token_hash on an exported table fails
   * here on the day it is added, which a hand-kept list of credential tables never would.
   */
  console.log('\n— NO CREDENTIAL LEAVES ON AN EXPORTED ROW —');
  const CRED = /passwordhash|password_hash|token_hash|code_hash|secret|refresh_token|access_token|id_token/i;
  const leaks = [];
  for (const model of M.EXPORTED_MODELS) {
    const e = M.TENANT_MANIFEST[model];
    for (const c of await colsOf(model)) {
      if (CRED.test(c) && !(e.redact ?? []).includes(c)) leaks.push(`${model}.${c}`);
    }
  }
  check('every credential-shaped column on an exported model is redacted',
    leaks.length === 0, leaks.join(', ') || 'none unredacted');
  check('  …and the clause can see the one that matters', (M.TENANT_MANIFEST.User.redact ?? []).includes('passwordHash'),
    'User.passwordHash is named, so the scan reaches a real planted case');

  /**
   * BYTES OUTSIDE POSTGRES. Enumerated the same way: any table holding an r2 key either carries the
   * blob marker or is not exported at all. A row-only export of photos is an index to files the
   * tenant cannot read, and the whole point is that the next such table cannot arrive unnoticed.
   */
  console.log('\n— ROWS THAT POINT AT BYTES —');
  const blobFaults = [];
  for (const t of tables) {
    const cols = [...await colsOf(t)];
    if (!cols.some((c) => c.includes('r2_key'))) continue;
    const e = M.TENANT_MANIFEST[t];
    if (!e) continue;
    if (e.take === 'export' && e.blob !== 'r2') blobFaults.push(`${t} holds an r2 key and is exported without the blob marker`);
  }
  check('every exported table holding R2 bytes is marked as holding them',
    blobFaults.length === 0, blobFaults.join(' | ') || 'JobCardPhoto marked; no unmarked blob table');

  /** THE SIX THAT DECAYED. Named explicitly, because they are the reason this file exists. */
  console.log('\n— THE TABLES THE PURGE SWEEP HAD TO FIND BY HAND —');
  const SUBJECT_KEYED = ['TwoFactorSecret', 'TwoFactorRecoveryCode', 'DeliveredCode', 'VerificationToken', 'AuthRateLimit'];
  const mis = SUBJECT_KEYED.filter((m) => M.TENANT_MANIFEST[m]?.reach.by !== 'subject' || M.TENANT_MANIFEST[m]?.take !== 'omit');
  check('each is classified subject-keyed AND omitted, not quietly reachable',
    mis.length === 0, mis.join(', ') || SUBJECT_KEYED.join(', '));
  check('  …and CountryWaitlist, which survived a purge with an email on it, is accounted for',
    M.TENANT_MANIFEST.CountryWaitlist?.take === 'omit' && !!M.TENANT_MANIFEST.CountryWaitlist?.because,
    M.TENANT_MANIFEST.CountryWaitlist?.because?.slice(0, 70));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PLANTED FAULTS — the predicate watched failing, one fault at a time
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— EVERY RULE, PLANTED AND CAUGHT —');
  const base = M.TENANT_MANIFEST;
  const schema = M.SCHEMA;
  const without = (model) => { const c = { ...base }; delete c[model]; return c; };
  const withEntry = (model, e) => ({ ...base, [model]: e });
  const cases = [
    ['a new model nobody classified', without('Invoice'), 'UNCLASSIFIED_MODEL'],
    ['an entry for a model that no longer exists', withEntry('JobCardWidget', { reach: { by: 'group' }, take: 'export' }), 'STALE_MANIFEST_ENTRY'],
    ['an omission with no reason', withEntry('Invoice', { reach: { by: 'group' }, take: 'omit' }), 'OMISSION_WITHOUT_REASON'],
    ['an omission reason that is only whitespace', withEntry('Invoice', { reach: { by: 'group' }, take: 'omit', because: '   ' }), 'OMISSION_WITHOUT_REASON'],
    ['a group_id claimed by a table without one', withEntry('InvoiceLine', { reach: { by: 'group' }, take: 'export' }), 'MANIFEST_CLAIMS_GROUP_ID'],
    ['a parent that is not a model', withEntry('InvoiceLine', { reach: { by: 'parent', through: 'Ledger' }, take: 'export' }), 'PARENT_IS_NOT_A_MODEL'],
    ['a model claiming to be its own parent', withEntry('InvoiceLine', { reach: { by: 'parent', through: 'InvoiceLine' }, take: 'export' }), 'PARENT_IS_ITSELF'],
    ['a parent with no join to it', withEntry('InvoiceLine', { reach: { by: 'parent', through: 'Customer' }, take: 'export' }), 'NO_PATH_TO_PARENT'],
    ['a tenant row reached only through something platform-wide', withEntry('InvoiceLine', { reach: { by: 'parent', through: 'Document' }, take: 'export' }), 'UNREACHABLE_PARENT_PATH'],
    ['a subject key naming a column that is not there', withEntry('VerificationToken', { reach: { by: 'subject', keyedOn: 'user_id' }, take: 'omit', because: 'x'.repeat(20) }), 'MANIFEST_CLAIMS_MISSING_COLUMN'],
    ['a redaction naming a renamed column', withEntry('User', { reach: { by: 'group' }, take: 'export', redact: ['password_hash'] }), 'REDACT_CLAIMS_MISSING_COLUMN'],
    ['a redaction on a row that is never exported', withEntry('Session', { reach: { by: 'parent', through: 'User' }, take: 'omit', because: 'x'.repeat(20), redact: ['id'] }), 'REDACT_ON_AN_OMISSION'],
    ['a blob marker with no r2 key behind it', withEntry('Customer', { reach: { by: 'group' }, take: 'export', blob: 'r2' }), 'BLOB_WITHOUT_KEY_COLUMN'],
    ['a reason on something that IS exported', withEntry('Invoice', { reach: { by: 'group' }, take: 'export', because: 'contradicts itself' }), 'REASON_ON_AN_EXPORT'],
  ];
  const missed = [];
  for (const [label, variant, code] of cases) {
    const f = M.auditManifest(variant, schema);
    if (!f.some((x) => x.startsWith(code))) missed.push(`${label} → expected ${code}, got ${f.join('; ').slice(0, 80) || 'NOTHING'}`);
  }
  check(`the predicate catches every fault it names (${cases.length} planted)`,
    missed.length === 0, missed.join(' | ') || `${cases.length} of ${cases.length} caught`);
  check('  …and says nothing about a manifest that is correct', M.auditManifest(base, schema).length === 0);

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await prisma?.$disconnect?.().catch(() => {});
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
