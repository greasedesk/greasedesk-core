/**
 * File: scripts/tenant-scope-gate.mjs
 * No API route may reach tenant data without a validated tenant scope — and the debt is a NUMBER.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 * Prisma THROWS on `group_id: null` against a non-nullable column. It SILENTLY DROPS THE FILTER on
 * `group_id: undefined` and returns every tenant's rows. Operators and reps carry no `group_id` on
 * the session at all — the JWT sets it only in the tenant branch — so undefined is reachable, not
 * theoretical. On the site axis the same mistake lost £2,485.43 from a figure; on the tenant axis
 * it is a cross-tenant read.
 *
 * ── WHY A SCANNER AND NOT JUST THE CHOKEPOINT ───────────────────────────────────────────────────
 * ~78 endpoints hand-roll the guard, correctly, in at least FIVE spellings. A sweep for the
 * unguarded read four of them as missing and nearly reported a false alarm. If an automated scan
 * cannot tell guarded from unguarded, neither can a reviewer — and the risk is not the 78 that are
 * right, it is the 79th. So: recognise both forms, fail on NEITHER, and print the migration debt.
 *
 * ── THE RATCHET ─────────────────────────────────────────────────────────────────────────────────
 * INLINE_GUARD_CEILING pins a DIRECTION, not a value. The inline count may fall freely; it may not
 * rise. That is the property-gate rule — pin the rule when the number can legitimately move — and
 * here it can only legitimately move one way. A new endpoint copying the old pattern pushes the
 * count up and goes red; migrating one lets the ceiling be lowered in the same commit.
 */
import './_gate-preflight.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── PURE PREDICATES, so they can be proven against synthetic sources ──────────────────────────
/** Does this handler touch tenant-scoped data at all? */
const touchesTenantData = (src) => /group_id\s*:/.test(src) || /\bgroupId\b/.test(src);
/** Route A — the chokepoint. Scope can only be OBTAINED from the thing that validated it. */
const usesChokepoint = (src) => /\brequireTenantApi\s*\(/.test(src);
/**
 * Route B — a recognised inline guard.
 *
 * STRUCTURAL, NOT A LIST OF SPELLINGS. The first version enumerated the five forms found in the
 * tree and promptly produced three FALSE POSITIVES: account/2fa and account/phone add an
 * `actorClass` clause, and jobcard.ts tests group_id before id. That is the sixth and seventh
 * spelling — chasing them one at a time is how the original problem got here, and a scanner that
 * cries wolf gets muted, which is worse than not having one.
 *
 * So the shape asserted is the BEHAVIOUR: a falsiness test on the tenant scope, with a 401/403
 * refusal close behind it. Order, extra clauses and variable naming are all free.
 */
const usesInlineGuard = (src) =>
  // The identifier prefix is OPTIONAL: `!user?.group_id`, `!u.group_id` and a bare `!groupId`
  // (onboarding/tax derives it first) are all the same guard wearing different clothes.
  /if \([^)]*!(?:\w+\??\.)?group_?[Ii]d[^)]*\)[\s\S]{0,140}?res\.status\(40[13]\)/.test(src)
  || /\brequireAdminApi\s*\(/.test(src)     // admin routes carry their own authority
  || /\brequireImportApi\s*\(/.test(src);
/** Reads the session directly — the thing that makes an unguarded read possible. */
const readsSession = (src) => /session\?\.user as any/.test(src) || /getServerSession\(/.test(src);

const walk = (dir) => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.ts') ? [p] : []);
});

// Tenant-actor routes only. These four families answer to a different authority and must NOT be
// pushed through a tenant guard — naming them is the alternative to an allow-list nobody audits.
const EXEMPT = [
  'pages/api/auth/',        // establishes the session; cannot require one
  'pages/api/webhooks/',    // Stripe/Svix — signature-verified, no session exists
  'pages/api/cron/',        // CRON_SECRET-guarded
  'pages/api/superadmin/',  // operator actor, region-scoped, has its own guard
  'pages/api/public/',      // deliberately unauthenticated
  'pages/api/c/',           // customer magic-link surfaces — the LINK is the credential
];
const files = walk('pages/api').filter((f) => !EXEMPT.some((p) => f.startsWith(p)));
const read = (f) => readFileSync(f, 'utf8');

console.log(`\n— ${files.length} tenant-actor API routes —`);

// A route is RELEVANT if it touches tenant data and establishes an actor at all. `readsSession`
// alone was wrong: migrating a route removes its getServerSession call, so the migrated ones
// vanished from the population and the chokepoint count read 0 while six were already done. A
// denominator that shrinks as you fix things measures the wrong thing.
const relevant = files.filter((f) => { const s = read(f); return touchesTenantData(s) && (readsSession(s) || usesChokepoint(s)); });
const unguarded = relevant.filter((f) => { const s = read(f); return !usesChokepoint(s) && !usesInlineGuard(s); });
const inline = relevant.filter((f) => { const s = read(f); return !usesChokepoint(s) && usesInlineGuard(s); });
const migrated = relevant.filter((f) => usesChokepoint(read(f)));

// ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
check('every session-reading route that touches tenant data is guarded', unguarded.length === 0,
  unguarded.length ? `\n    ${unguarded.join('\n    ')}` : `${relevant.length} routes, none unguarded`);

// ── THE DEBT, AS A NUMBER ─────────────────────────────────────────────────────────────────────
// Lower this in the same commit that migrates a route. It must never be raised.
// SET TO THE CURRENT COUNT, not a round number above it. A ceiling with slack is not a ratchet —
// it silently permits the next few copies of the pattern, which is the whole thing being stopped.
const INLINE_GUARD_CEILING = 57;
console.log(`\n  chokepoint: ${migrated.length}   inline: ${inline.length}   ceiling: ${INLINE_GUARD_CEILING}`);
check('the inline-guard count has not RISEN', inline.length <= INLINE_GUARD_CEILING,
  inline.length <= INLINE_GUARD_CEILING
    ? `${INLINE_GUARD_CEILING - inline.length} below the ceiling — lower it when you migrate`
    : `${inline.length} > ${INLINE_GUARD_CEILING}: a new route copied the old pattern. Use requireTenantApi.`);

// ── THE CHOKEPOINT'S DEFINING PROPERTY ────────────────────────────────────────────────────────
const guard = read('lib/admin-guard.ts');
check('TenantScope.groupId is NON-NULLABLE', /groupId:\s*string;/.test(guard.split('export type TenantScope')[1]?.slice(0, 400) ?? ''),
  'the point is not one place to check — it is that scope can only be OBTAINED from the validator');
check('it refuses a session with no tenant', /if \(!vis\.groupId\) \{ res\.status\(401\)/.test(guard),
  'operators and reps are not tenant actors; they get 401 by construction');

// ── AND THE RULES BITE ────────────────────────────────────────────────────────────────────────
console.log('\n— proven on synthetic sources —');
const BAD = "const user = session?.user as any;\nconst rows = await prisma.invoice.findMany({ where: { group_id: user.group_id } });\n";
const OK_A = "const scope = await requireTenantApi(req, res);\nif (!scope) return;\nwhere: { group_id: scope.groupId }\n";
const OK_B = "const user = session?.user as any;\nif (!user?.id || !user?.group_id) return res.status(401).json({});\nwhere: { group_id: user.group_id }\n";
check('an unguarded session read that scopes on group_id is FLAGGED',
  readsSession(BAD) && touchesTenantData(BAD) && !usesChokepoint(BAD) && !usesInlineGuard(BAD));
check('the chokepoint form passes', usesChokepoint(OK_A));
check('the inline form passes', usesInlineGuard(OK_B) && !usesChokepoint(OK_B),
  'recognised, so the gate is green today — the debt is reported, not failed');
check('a route touching no tenant data is not relevant', !touchesTenantData("res.status(200).json({ ok: true });"));
check('the check is discriminating — sUser spelling is recognised too',
  usesInlineGuard("if (!sUser?.id || !sUser?.group_id) return res.status(401).json({});"),
  'four of five spellings read as UNGUARDED by my first sweep; that false alarm is what this encodes');
// The three shapes that made the FIRST version of this predicate cry wolf. Pinned so a future
// tightening cannot quietly reintroduce them.
check('an extra actorClass clause is still recognised',
  usesInlineGuard("if (!u?.id || !u?.group_id || (u.actorClass && u.actorClass !== 'tenant')) {\n  return res.status(401).json({ message: 'Not authenticated.' });\n}"));
check('group_id tested BEFORE id is still recognised',
  usesInlineGuard("if (!user?.group_id || !user?.site_id) {\n  return res.status(401).json({ message: 'no context' });\n}"));
check('a bare derived groupId check is still recognised',
  usesInlineGuard("const groupId = x;\nif (!groupId) return res.status(401).json({ message: 'No group in scope.' });"));
// And it must still refuse a test with NO refusal behind it.
check('a falsiness test with no 401 nearby is NOT a guard',
  !usesInlineGuard("if (!user?.group_id) { console.warn('no group'); }\n"),
  'the refusal is the guard, not the mention');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
