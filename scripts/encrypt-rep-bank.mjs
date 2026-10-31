/**
 * File: scripts/encrypt-rep-bank.mjs
 * THE ONE-OFF: encrypt any Rep bank details still stored in clear, and fill in the last four digits.
 *
 *   node scripts/encrypt-rep-bank.mjs                         > /tmp/x.log 2>&1   # DRY RUN, no key needed
 *   node scripts/encrypt-rep-bank.mjs --write                  > /tmp/x.log 2>&1   # this database
 *   node scripts/encrypt-rep-bank.mjs --yes-production --expect-rows=N [--write]    # production, at a terminal
 *
 * ── THE DRY RUN NEEDS NO KEY, AND THAT WAS A DEFECT WORTH FIXING (owner, 2026-10-31) ────────────
 * The first version refused before reading a single row unless a key was present, so you could not
 * even COUNT production's rows without handing a secret to a script. Backwards: counting is the
 * question you ask first, and it is the answer that decides whether a key is needed at all. Now the
 * key is required only by --write, and only when there is work to do.
 *
 * ── IT REFUSES A KEY THAT DOES NOT BELONG TO THE DATABASE IT IS POINTED AT ──────────────────────
 * The hazard the owner named: the gate key against production would encrypt real bank details into
 * ciphertext production can never read — a ✓ on every row and nothing to notice afterwards. There is
 * no way to detect it from the data, because a fresh database holds nothing encrypted to test
 * against. So lib/payee-key-check compares the key's FINGERPRINT against the one registered for the
 * ENVIRONMENT MARKER, which is a property of the database and not of the URL.
 *
 * ── AND IT WILL NOT TOUCH PRODUCTION UNATTENDED ─────────────────────────────────────────────────
 * --yes-production reads .migrate-target.production (the same file migrate-apply uses, so the
 * production URLs have ONE home and there is no swap to forget), refuses unless that file really
 * names production, requires --expect-rows to match what it finds, prints the endpoint, and makes a
 * person type the endpoint id back on a TTY. With stdin not a terminal it refuses outright, so this
 * cannot run from CI, from a script, or by an agent. It belongs to somebody at a keyboard.
 *
 * ── IDEMPOTENT, BY A DECIDABLE TEST ─────────────────────────────────────────────────────────────
 * A value already carrying the `v1:` envelope is skipped — lib/payee-crypto's own test, so this and
 * the reader agree by construction. Running twice is a no-op; running after a partial failure
 * finishes the job.
 *
 * ── IT NEVER PRINTS A DIGIT ─────────────────────────────────────────────────────────────────────
 * Not in a dry run, not on failure. Counts, ref codes and fingerprints only.
 *
 * ── THE PIPE REFUSAL IS WANTED HERE ─────────────────────────────────────────────────────────────
 * A SIGPIPE part-way through a column rewrite is half a job on a shared database. Redirect to a file.
 */
import './_gate-preflight.mjs';

const { existsSync, readFileSync } = await import('node:fs');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const WRITE = process.argv.includes('--write');
const YES_PRODUCTION = process.argv.includes('--yes-production');
const EXPECT_ROWS = (() => {
  const a = process.argv.find((x) => x.startsWith('--expect-rows='));
  if (!a) return null;
  const n = Number(a.split('=')[1]);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
})();

/**
 * ── THE PRODUCTION TARGET IS SET BEFORE lib/db IS IMPORTED ──────────────────────────────────────
 * lib/db builds its client from DATABASE_URL at import time and is what loads .env. Setting these
 * first wins, because dotenv does not override an already-set variable (measured). Importing the
 * client first and then changing the environment would talk to the gate database while printing
 * production's endpoint — the asymmetry _db-target exists to catch.
 */
if (YES_PRODUCTION) {
  const file = `${ROOT}/.migrate-target.production`;
  if (!existsSync(file)) {
    console.error(`\n  --yes-production needs ${file}, holding ONLY the production DATABASE_URL and DIRECT_URL.`);
    console.error('  It is the same file migrate-apply uses. Move those two lines out of .env rather than');
    console.error('  copying them, so there is one home for each and no swap to undo.\n');
    process.exit(2);
  }
  if (EXPECT_ROWS === null || Number.isNaN(EXPECT_ROWS)) {
    console.error('\n  --yes-production also needs --expect-rows=<N>, a whole number.');
    console.error('  Saying how many rows you expect is what stops a surprise being rewritten: run the DRY RUN');
    console.error('  first (it needs no key), read the count, then pass it back.\n');
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
  console.error('  Refusing: a tool that rewrites where money goes does not get to decide that quietly.\n');
  process.exit(2);
}

import './_ts.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
const { prisma } = await import('../lib/db.ts');
const { encryptPayee, isPayeeEncrypted, payeeLast4, payeeKeyFingerprint } = await import('../lib/payee-crypto.ts');
const { payeeKeyRefusal } = await import('../lib/payee-key-check.ts');
const { readEnvironment } = await import('../lib/environment.ts');

const env = await readEnvironment(prisma);
console.log(`\n  target        ${TARGET.runtime} · ${TARGET.runtimeEndpoint ?? '—'}`);
console.log(`  marker        ${env.kind ?? `UNKNOWN (${env.why}: ${env.detail})`}`);
console.log(`  mode          ${WRITE ? 'WRITING' : 'DRY RUN — nothing will be written'}`);

/**
 * THE ROWS FIRST, BEFORE ANY KEY IS ASKED FOR. This is the question the dry run exists to answer,
 * and on a database with nothing to encrypt it is also the whole answer.
 */
const reps = await prisma.rep.findMany({
  where: { NOT: { bank_sort_code: null } },
  select: {
    id: true, ref_code: true, party_type: true,
    bank_sort_code: true, bank_account_number: true, bank_account_last4: true,
  },
  orderBy: { created_at: 'asc' },
});

const needsWork = reps.filter((r) => !isPayeeEncrypted(r.bank_sort_code)
  || (r.bank_account_number && !isPayeeEncrypted(r.bank_account_number))
  || (!r.bank_account_last4 && !!r.bank_account_number));

console.log(`  rows          ${reps.length} hold bank details · ${needsWork.length} need changing\n`);

if (YES_PRODUCTION && reps.length !== EXPECT_ROWS) {
  console.error(`  REFUSED: --expect-rows=${EXPECT_ROWS} but this database holds ${reps.length}.`);
  console.error('  Either the dry run was read against a different database, or something changed since.');
  console.error('  NOTHING HAS BEEN WRITTEN.\n');
  await prisma.$disconnect();
  process.exit(2);
}

if (reps.length === 0) {
  // NOTHING TO CHECK IS NOT CHECKED, and it is worth one explicit line: a reader seeing no output
  // cannot tell this from a script that failed to connect. It is also the whole of step 3 when true.
  console.log('  Nothing to do: no Rep row has a sort code, so there is no plaintext to encrypt and no');
  console.log('  key is needed. That is a positive report of safety, not an empty result.\n');
  await prisma.$disconnect();
  process.exit(0);
}

if (!WRITE) {
  for (const r of reps) {
    const plan = [
      !isPayeeEncrypted(r.bank_sort_code) ? 'sort code → encrypted' : null,
      r.bank_account_number && !isPayeeEncrypted(r.bank_account_number) ? 'account number → encrypted' : null,
      !r.bank_account_last4 && r.bank_account_number ? 'last four → filled' : null,
    ].filter(Boolean).join(', ');
    console.log(`  · ${r.ref_code} (${r.party_type}) — ${plan || 'already encrypted, last four present'}`);
  }
  console.log(`\n  DRY RUN — nothing written. ${needsWork.length} row(s) would change.`);
  if (needsWork.length) console.log('  Re-run with --write (and --yes-production --expect-rows=N on production).');
  console.log('');
  await prisma.$disconnect();
  process.exit(0);
}

/**
 * ── THE KEY IS CHECKED HERE: THERE IS WORK, AND WE ARE ABOUT TO WRITE ───────────────────────────
 * Against the ENVIRONMENT MARKER, not the URL — see lib/payee-key-check. A wrong key here is the
 * failure with no symptom, so it is the one thing between reading the rows and rewriting them.
 */
const refusal = await payeeKeyRefusal(prisma);
if (refusal) {
  console.error(`  REFUSED (${refusal.code}): ${refusal.message}`);
  console.error('\n  NOTHING HAS BEEN WRITTEN.\n');
  await prisma.$disconnect();
  process.exit(2);
}
console.log(`  key           fingerprint ${payeeKeyFingerprint()} — matches the one registered for "${env.kind}"\n`);

if (YES_PRODUCTION) {
  if (!process.stdin.isTTY) {
    console.error('  REFUSED: --yes-production needs a terminal. This cannot be run from a script, from CI,');
    console.error('  or by an agent — it belongs to a person at a keyboard. NOTHING HAS BEEN WRITTEN.\n');
    await prisma.$disconnect();
    process.exit(2);
  }
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`  About to rewrite ${needsWork.length} row(s) on ${TARGET.runtimeEndpoint}.\n  Type the endpoint id to proceed, anything else to abort:\n  > `)).trim();
  rl.close();
  if (typed !== TARGET.runtimeEndpoint) {
    console.error('\n  Aborted. NOTHING HAS BEEN WRITTEN.\n');
    await prisma.$disconnect();
    process.exit(2);
  }
}

let done = 0;
let already = 0;
let failed = 0;

for (const r of reps) {
  const sortClear = !isPayeeEncrypted(r.bank_sort_code);
  const acctClear = r.bank_account_number ? !isPayeeEncrypted(r.bank_account_number) : false;
  const needsLast4 = !r.bank_account_last4 && !!r.bank_account_number;

  if (!sortClear && !acctClear && !needsLast4) {
    already += 1;
    console.log(`  · ${r.ref_code} (${r.party_type}) — already encrypted, last four present`);
    continue;
  }

  const plan = [
    sortClear ? 'sort code → encrypted' : null,
    acctClear ? 'account number → encrypted' : null,
    needsLast4 ? 'last four → filled' : null,
  ].filter(Boolean).join(', ');

  try {
    /**
     * THE LAST FOUR COMES FROM WHICHEVER FORM THE ROW IS IN. Still clear, and it is the source;
     * already encrypted with only the last four missing, and there is nothing to derive it from
     * here — reported rather than guessed, because a wrong last four on a remittance is a plausible
     * wrong value and those outlive implausible ones.
     */
    const last4 = acctClear && r.bank_account_number ? payeeLast4(r.bank_account_number) : r.bank_account_last4;
    if (needsLast4 && !last4) {
      failed += 1;
      console.error(`  ✗ ${r.ref_code} — the account number is already encrypted and the last four is missing;`);
      console.error('      it cannot be derived here without decrypting. Reveal it in the Engine Room and set it there.');
      continue;
    }

    await prisma.rep.update({
      where: { id: r.id },
      data: {
        ...(sortClear ? { bank_sort_code: encryptPayee(r.bank_sort_code) } : {}),
        ...(acctClear && r.bank_account_number ? { bank_account_number: encryptPayee(r.bank_account_number) } : {}),
        ...(last4 ? { bank_account_last4: last4 } : {}),
      },
    });
    done += 1;
    console.log(`  ✓ ${r.ref_code} (${r.party_type}) — ${plan}`);
  } catch (e) {
    failed += 1;
    // describeError leads with the error CLASS, so an error with no message still names itself.
    console.error(`  ✗ ${r.ref_code} — ${describeError(e)}`);
  }
}

console.log(`\n  ${done} written · ${already} already done · ${failed} failed`);
if (failed) console.log('  SOME ROWS FAILED. Re-running is safe: finished rows are skipped by their v1: envelope.');
console.log('');

await prisma.$disconnect();
process.exit(failed ? 1 : 0);
