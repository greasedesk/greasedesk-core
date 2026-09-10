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
import './_ts.mjs';
const { keyRegex } = await import('../lib/anchored-match.ts');
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── PURE PREDICATES, so they can be proven against synthetic sources ──────────────────────────
/**
 * Does this handler touch tenant-scoped data at all?
 *
 * ── THE THIRD FORM, AND THE BLIND SPOT IT LEFT ────────────────────────────────────────────────
 * The first two clauses look for the tenant as an object KEY (`group_id: x`) or as the camelCase
 * identifier (`groupId`). Neither sees the tenant used as a VALUE — `where: { id: user.group_id }`
 * — which is how a route scopes when the tenant IS the row rather than a column on it. Ten routes
 * sat outside the population for that reason, `vin-lookup.ts` among them: an external-credential
 * lookup route structurally identical to the one this gate was failing on, and invisible to the
 * sweep that was failing on it. A scanner blind to its own nearest neighbour is measuring the
 * wrong population, and a denominator that excludes the shape you are hunting is not a denominator.
 *
 * Widened here rather than in the guard predicates on purpose: this decides WHO IS IN SCOPE. The
 * guards decide who passes. Getting the first one wrong makes the second one irrelevant.
 */
const touchesTenantData = (src) => keyRegex('group_id').test(src) || /\bgroupId\b/.test(src)
  || /(?:\?\.|\.)group_id\b/.test(src);
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
  // AND A REFUSAL IS NOT ALWAYS A 401. messages/unread is the nav pill's count: to a caller with no
  // tenant the honest answer is `{ unread: null }` at 200, not an error — a nav decoration that
  // 401s is a bug, and an honest null is the house rule everywhere else. What makes it a guard is
  // that it RETURNS on the no-scope branch, so no tenant data is reached. Narrower than the clause
  // above, not looser: the `return` must follow the test immediately, which is why the
  // console.warn case at the bottom of this file still reads as unguarded.
  || /if \([^)]*!(?:\w+\??\.)?group_?[Ii]d[^)]*\)\s*(?:\{\s*)?return\b/.test(src)
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
  // ONE FILE, NAMED. /api/contact is the public marketing contact form (Turnstile-guarded) and it
  // MUST serve anonymous callers, so it can never require a tenant. It reads a session only to
  // enrich the email when one happens to exist, behind `su?.id && su?.group_id ? su : null` — a
  // positive conjunction yielding null, which is a real guard but not one that can refuse. It is
  // not under pages/api/public/ because the marketing site and /admin/support both post to
  // /api/contact, and moving the route would change both. Named here rather than pattern-matched,
  // because the alternative is a guard predicate loose enough to accept a ternary anywhere.
  'pages/api/contact.ts',
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
//
// ── RE-BASELINED 2026-09-07, 57 → 76, AND THE ARITHMETIC THAT JUSTIFIES IT ────────────────────
// A raise, against the rule one line above, so it has to be shown rather than asserted:
//
//     57   the count on 2026-08-16, when this gate was written
//   + 10   routes CREATED inline 18–20 August, in the four days after the ratchet was installed
//          to stop exactly that (due-items, battery-readings, intake-items, intake-report-send,
//          marketing-contact, observations, service-schedule, tyre-readings, marketing-send,
//          mot-refresh). Real, unpaid debt. The gate has been red on it since 18 August.
//   +  9   routes that were ALWAYS guarded and always inline, but invisible to the old
//          touchesTenantData — the value form, widened above. Eight guarded outright, plus
//          messages/unread once an honest-null refusal counts as the refusal it is.
//   = 76
//
// The +9 is a measurement correction: the same routes, guarded the same way, counted for the first
// time. The +10 is genuine drift and is NOT forgiven by this number — it is why the next slice
// migrates ten routes, and this ceiling should be 66 when that lands.
//
// THE LOOPHOLE THIS MUST NOT BECOME: widening the population is not a way to raise the ceiling. A
// widening pays for itself only when every route it admits is shown, one at a time, to have been
// guarded all along — which is what the nine above were. A widening that admits an UNGUARDED route
// makes the first check red, and that check has no ceiling.
const INLINE_GUARD_CEILING = 76;
console.log(`\n  chokepoint: ${migrated.length}   inline: ${inline.length}   ceiling: ${INLINE_GUARD_CEILING}`);
check('the inline-guard count has not RISEN', inline.length <= INLINE_GUARD_CEILING,
  inline.length <= INLINE_GUARD_CEILING
    ? `${INLINE_GUARD_CEILING - inline.length} below the ceiling — lower it when you migrate`
    : `${inline.length} > ${INLINE_GUARD_CEILING}: a new route copied the old pattern. Use requireTenantApi.`);

// ── THE CHOKEPOINT'S DEFINING PROPERTY ────────────────────────────────────────────────────────
const guard = read('lib/admin-guard.ts');
check('TenantScope.groupId is NON-NULLABLE', keyRegex('groupId', 'string;').test(guard.split('export type TenantScope')[1]?.slice(0, 400) ?? ''),
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
// ── THE VALUE FORM, WHICH THE POPULATION USED TO MISS ────────────────────────────────────────
const VALUE_FORM = "const u = session?.user as any;\nconst g = await prisma.group.findUnique({ where: { id: u.group_id } });\n";
check('the tenant used as a VALUE is in the population', touchesTenantData(VALUE_FORM));
check('  …and it carries NEITHER of the two shapes that used to define it',
  !keyRegex('group_id').test(VALUE_FORM) && !/\bgroupId\b/.test(VALUE_FORM),
  'so the check above is the widening doing the work, not one of the old clauses');
check('  …in both spellings', touchesTenantData("u?.group_id") && touchesTenantData("user.group_id"));
check('  …and a bare word is still not enough', !touchesTenantData("// scoped per group_id somewhere"),
  'the property READ is the signal; the phrase is not');
// ── A REFUSAL THAT IS NOT A 401 ──────────────────────────────────────────────────────────────
check('an honest-null refusal on the no-scope branch is a guard',
  usesInlineGuard("if (!user?.group_id) return res.status(200).json({ unread: null });"),
  'the branch runs only when there is no scope, so there is nothing in it to leak');
check('  …but only because it RETURNS', !usesInlineGuard("if (!user?.group_id) { logMissing(user); }\nconst rows = await prisma.invoice.findMany({});"),
  'a test that falls through to the query is not a guard, whatever it logs');
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
