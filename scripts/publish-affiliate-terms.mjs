/**
 * File: scripts/publish-affiliate-terms.mjs
 * PUBLISH THE AFFILIATE TERMS from content/affiliate-terms.md.
 *
 *   node scripts/publish-affiliate-terms.mjs                      > /tmp/x.log 2>&1   # DRY RUN
 *   node scripts/publish-affiliate-terms.mjs --write               > /tmp/x.log 2>&1   # draft only
 *   node scripts/publish-affiliate-terms.mjs --write --publish --effective-from=YYYY-MM-DD
 *
 * — and on production, with --yes-production in front of all of it:
 *
 *   node scripts/publish-affiliate-terms.mjs --yes-production      > /tmp/x.log 2>&1   # DRY RUN
 *   node scripts/publish-affiliate-terms.mjs --yes-production --write --publish --effective-from=YYYY-MM-DD
 *
 * ── WHY THE FLAG EXISTS, ADDED 2026-11-01 ───────────────────────────────────────────
 * Without it there was no production command at all, and worse than that, the command in the lines
 * above LOOKED like one. .env holds the GATE database — that is the premise every gate in this
 * repository runs on — so publishing “the terms” locally spent a version stamp on the gate
 * database, printed a tidy ✓, and left production still showing the summary. The owner would have
 * had to work out why from nothing.
 *
 * It matters more here than in the scripts that already had the flag, because a PUBLISHED LEGAL
 * VERSION IS IMMUTABLE: the stamp is spent and the words cannot be corrected. Aiming an irreversible
 * write at the wrong database is the one mistake an editor cannot undo afterwards.
 *
 * The flag reads .migrate-target.production — the same file migrate-apply and encrypt-rep-bank use,
 * so the production URLs have one home and there is no swap to forget — and the refusals run in both
 * directions: the flag with a non-production target is as wrong as production without the flag.
 *
 * ── THE DRY RUN NEEDS NO TERMINAL; THE WRITE DOES ──────────────────────────────────
 * Deliberately split, because they are different acts. Reading production's figures and printing
 * the text that WOULD be stored changes nothing, and somebody should be able to have that put in
 * front of them without being at the keyboard. Spending the version belongs to a person: the write
 * path asks for a terminal and for the endpoint id to be typed, as encrypt-rep-bank does.
 *
 * ── DRY RUN IS THE DEFAULT, AND IT PRINTS THE BAKED TEXT ────────────────────────────────────────
 * A published legal version is immutable: the stamp is spent and the words cannot be corrected.
 * So the only safe first action is to show what WOULD be stored — every figure substituted, the
 * whole body — and let a person read it. The dry run writes nothing and touches no draft.
 *
 * ── IT IS NOT A SECOND PUBLISH PATH ─────────────────────────────────────────────────────────────
 * The write goes through lib/content-publish::publishDraft, the same function the Engine Room
 * button calls, so the order that matters (bake → refuse a placeholder → refuse a no-op against
 * the baked body → stamp → write) cannot differ between them. This script only supplies the draft
 * and the effective date.
 *
 * ── WHY A SCRIPT AT ALL, WHEN THERE IS AN EDITOR ────────────────────────────────────────────────
 * Because the SOURCE of these words is a file in the repository, reviewable in a diff, and pasting
 * ten kilobytes of markdown into a textarea is how a clause goes missing. The editor remains the
 * place to amend them afterwards; this is how version 1 gets in, on each database, identically.
 *
 * ── THE PIPE REFUSAL IS WANTED HERE ─────────────────────────────────────────────────────────────
 * A SIGPIPE part-way through is a half-written document row. Redirect to a file.
 */
import './_ts.mjs';

const { readFileSync, existsSync } = await import('node:fs');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SOURCE = `${ROOT}/content/affiliate-terms.md`;
const WRITE = process.argv.includes('--write');
const PUBLISH = process.argv.includes('--publish');
const YES_PRODUCTION = process.argv.includes('--yes-production');
const EFFECTIVE = (process.argv.find((a) => a.startsWith('--effective-from=')) ?? '').split('=')[1] ?? null;
const COUNTRY = 'GB';

/**
 * THE TARGET IS SET BEFORE lib/db IS IMPORTED, which is the whole of why this block sits above the
 * imports rather than beside the other flags. lib/db builds its client from DATABASE_URL at import
 * time and is what loads .env, and dotenv does not override an already-set variable — so setting
 * these first wins. Import the client first and this would talk to the gate database while printing
 * production's endpoint, which is the asymmetry _db-target exists to catch.
 */
if (YES_PRODUCTION) {
  const file = `${ROOT}/.migrate-target.production`;
  if (!existsSync(file)) {
    console.error(`\n  --yes-production needs ${file}, holding ONLY the production DATABASE_URL and DIRECT_URL.`);
    console.error('  It is the same file migrate-apply and encrypt-rep-bank use. NOTHING HAS BEEN READ.\n');
    process.exit(2);
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { describeTarget } = await import('./_db-target.mjs');
const TARGET = describeTarget(ROOT);

if (YES_PRODUCTION && TARGET.runtime !== 'production') {
  console.error(`\n  --yes-production was passed, but the target is ${TARGET.runtime} (${TARGET.runtimeEndpoint ?? '—'}).`);
  console.error('  The flag is a statement of intent, and a mismatch means something is wrong rather than');
  console.error('  something is safe. NOTHING HAS BEEN READ.\n');
  process.exit(2);
}
if (!YES_PRODUCTION && TARGET.runtime === 'production') {
  console.error(`\n  This is pointed at PRODUCTION (${TARGET.runtimeEndpoint}) and --yes-production was not passed.`);
  console.error('  Refusing: a published version is immutable, so it does not get published quietly.\n');
  process.exit(2);
}

const { describeError } = await import('./_gate-preflight.mjs');
const { prisma } = await import('../lib/db.ts');
const { AFFILIATE_TERMS_SLUG, bakeFigures, refuseUnbaked, termsFigures } = await import('../lib/affiliate-terms.ts');
const { publishDraft } = await import('../lib/content-publish.ts');
const { DRAFT } = await import('../lib/content.ts');

const body = readFileSync(SOURCE, 'utf8');
// THE TITLE COMES FROM THE DOCUMENT'S OWN H1, not from a constant here — two spellings of a legal
// document's name is one of them being wrong on somebody's screen.
const title = (/^#\s+(.+)$/m.exec(body) ?? [])[1]?.trim() ?? 'GreaseDesk Affiliate Terms';

const figures = await termsFigures(prisma);
const { body: bakedBody, unfilled } = bakeFigures(body, figures);
const refusal = refuseUnbaked(unfilled);

/**
 * WHICH DATABASE, PRINTED FIRST AND ON EVERY RUN. The marker comes from the data rather than from
 * the connection string, because a restored copy of production carries it and an endpoint id does
 * not. A reader who sees `test` here knows the baked figures below are the gate's, not the ones a
 * real affiliate will be held to.
 */
const env = await prisma.environment.findUnique({ where: { id: 'singleton' }, select: { kind: true } }).catch(() => null);
console.log(`\n  database ${TARGET.runtimeEndpoint ?? '(unknown endpoint)'} · marker ${env?.kind ?? 'MISSING'}`
  + `${YES_PRODUCTION ? ' · --yes-production' : ''}`);
console.log(`  source   ${SOURCE.replace(ROOT, '.')}`);
console.log(`  title    ${title}`);
console.log(`  slug     ${AFFILIATE_TERMS_SLUG} (${COUNTRY}, legal)`);
console.log('\n  FIGURES THAT WOULD BE BAKED IN:');
for (const [k, v] of Object.entries(figures)) {
  // The minimum-payout sentence is the whole sentence or nothing; printed with its emptiness
  // visible, because "" is the interesting case and an empty line would hide it.
  console.log(`    ${k.padEnd(24)} ${v === '' ? '(empty — no minimum, so the sentence is omitted)' : String(v)}`);
}

if (refusal) {
  console.error(`\n  REFUSED: ${refusal}\n`);
  await prisma.$disconnect();
  process.exit(2);
}

const existing = await prisma.document.findFirst({
  where: { slug: AFFILIATE_TERMS_SLUG, country_code: COUNTRY },
  orderBy: { created_at: 'desc' },
  select: { id: true, version: true, status: true },
});

if (!WRITE) {
  console.log('\n  ── THE BAKED BODY, EXACTLY AS IT WOULD BE STORED ─────────────────────────────');
  console.log(bakedBody.split('\n').map((l) => `  | ${l}`).join('\n'));
  console.log(`\n  Existing rows for this slug: ${existing ? `${existing.status} ${existing.version}` : 'none'}`);
  console.log('  DRY RUN — nothing written. Re-run with --write to create the draft,');
  console.log('  and --write --publish --effective-from=YYYY-MM-DD to publish it.\n');
  await prisma.$disconnect();
  process.exit(0);
}

/**
 * AND THE WRITE ITSELF BELONGS TO A PERSON. Only on production, and only on the write path: the dry
 * run above has already exited, having changed nothing. Typing the endpoint id is the same
 * confirmation encrypt-rep-bank asks for, and for the same reason — a flag can be pasted from a
 * note, and an endpoint id has to be read off the screen in front of you.
 */
if (YES_PRODUCTION) {
  if (!process.stdin.isTTY) {
    console.error('  REFUSED: --yes-production --write needs a terminal. This cannot be run from a script, from');
    console.error('  CI, or by an agent — it belongs to a person at a keyboard. NOTHING HAS BEEN WRITTEN.\n');
    await prisma.$disconnect();
    process.exit(2);
  }
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const what = PUBLISH ? `PUBLISH version effective ${EFFECTIVE ?? '(no date given)'}` : 'overwrite the draft';
  const typed = (await rl.question(`\n  About to ${what} on ${TARGET.runtimeEndpoint}.`
    + `${PUBLISH ? '\n  A published version is IMMUTABLE — the stamp is spent and the words cannot be corrected.' : ''}`
    + '\n  Type the endpoint id to proceed, anything else to abort:\n  > ')).trim();
  rl.close();
  if (typed !== TARGET.runtimeEndpoint) {
    console.error('\n  Aborted. NOTHING HAS BEEN WRITTEN.\n');
    await prisma.$disconnect();
    process.exit(2);
  }
}

try {
  let draftId;
  const draft = await prisma.document.findFirst({
    where: { slug: AFFILIATE_TERMS_SLUG, country_code: COUNTRY, version: DRAFT },
    select: { id: true },
  });
  if (draft) {
    // THE DRAFT IS OVERWRITTEN, which is what a draft is for — it is the one mutable row per slug.
    await prisma.document.update({ where: { id: draft.id }, data: { title, body } });
    draftId = draft.id;
    console.log(`\n  ✓ existing draft updated from the file`);
  } else {
    const made = await prisma.document.create({
      data: { slug: AFFILIATE_TERMS_SLUG, title, type: 'legal', country_code: COUNTRY, body, version: DRAFT, status: 'draft' },
      select: { id: true },
    });
    draftId = made.id;
    console.log(`\n  ✓ draft created`);
  }
  // THE DRAFT HOLDS THE UNBAKED SOURCE, deliberately: it is the editable thing, and baking it here
  // would mean the next edit started from substituted text and lost the placeholders for ever.
  console.log('    (the draft holds the placeholders; publishing is what bakes them)');

  if (!PUBLISH) {
    console.log('\n  Draft only. Publish it in the Engine Room, or re-run with');
    console.log('  --publish --effective-from=YYYY-MM-DD.\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  const r = await publishDraft(prisma, { id: draftId, effectiveFrom: EFFECTIVE });
  if (!r.ok) {
    console.error(`\n  REFUSED (${r.code}): ${r.message}\n`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`  ✓ published version ${r.version}, effective ${r.effectiveFrom.toISOString().slice(0, 10)}`);
  console.log(`    figures baked: ${r.baked}`);
  const stored = await prisma.document.findUnique({ where: { id: draftId }, select: { body: true } });
  // READ BACK, because "the update ran" and "the stored text is literal" are different claims.
  console.log(`    stored body carries a placeholder: ${/\{\{[a-zA-Z]/.test(stored?.body ?? '')}`);
  console.log('');
} catch (e) {
  console.error(`\n  FAILED: ${describeError(e)}\n`);
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.$disconnect();
process.exit(0);
