/**
 * File: scripts/publish-affiliate-terms.mjs
 * PUBLISH THE AFFILIATE TERMS from content/affiliate-terms-v1.md.
 *
 *   node scripts/publish-affiliate-terms.mjs                      > /tmp/x.log 2>&1   # DRY RUN
 *   node scripts/publish-affiliate-terms.mjs --write               > /tmp/x.log 2>&1   # draft only
 *   node scripts/publish-affiliate-terms.mjs --write --publish --effective-from=YYYY-MM-DD
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

const { readFileSync } = await import('node:fs');
const { describeError } = await import('./_gate-preflight.mjs');
const { prisma } = await import('../lib/db.ts');
const { AFFILIATE_TERMS_SLUG, bakeFigures, refuseUnbaked, termsFigures } = await import('../lib/affiliate-terms.ts');
const { publishDraft } = await import('../lib/content-publish.ts');
const { DRAFT } = await import('../lib/content.ts');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SOURCE = `${ROOT}/content/affiliate-terms-v1.md`;
const WRITE = process.argv.includes('--write');
const PUBLISH = process.argv.includes('--publish');
const EFFECTIVE = (process.argv.find((a) => a.startsWith('--effective-from=')) ?? '').split('=')[1] ?? null;
const COUNTRY = 'GB';

const body = readFileSync(SOURCE, 'utf8');
// THE TITLE COMES FROM THE DOCUMENT'S OWN H1, not from a constant here — two spellings of a legal
// document's name is one of them being wrong on somebody's screen.
const title = (/^#\s+(.+)$/m.exec(body) ?? [])[1]?.trim() ?? 'GreaseDesk Affiliate Terms';

const figures = await termsFigures(prisma);
const { body: bakedBody, unfilled } = bakeFigures(body, figures);
const refusal = refuseUnbaked(unfilled);

console.log(`\n  source   ${SOURCE.replace(ROOT, '.')}`);
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
