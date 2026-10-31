/**
 * File: scripts/encrypt-rep-bank.mjs
 * THE ONE-OFF: encrypt any Rep bank details that are still stored in clear, and fill in the last
 * four digits beside them.
 *
 *   node scripts/encrypt-rep-bank.mjs            > /tmp/x.log 2>&1   # DRY RUN — reports, writes nothing
 *   node scripts/encrypt-rep-bank.mjs --write    > /tmp/x.log 2>&1   # does it
 *
 * ── DRY RUN IS THE DEFAULT, AND --write IS A SENTENCE SOMEBODY TYPES ────────────────────────────
 * This rewrites columns that decide where money goes. A script whose default action is to write is a
 * script that gets run by accident while somebody is working out what it does. The dry run answers
 * the only question worth asking first — how many rows are there, and are any already done — and
 * answers it without touching anything.
 *
 * ── IDEMPOTENT, BY A DECIDABLE TEST AND NOT A GUESS ─────────────────────────────────────────────
 * A value already carrying the `v1:` envelope is skipped. That is lib/payee-crypto's own test, so
 * this script and the reader agree by construction rather than by two regexes that look similar.
 * Running it twice is a no-op; running it after a partial failure finishes the job.
 *
 * ── IT NEVER PRINTS A DIGIT ─────────────────────────────────────────────────────────────────────
 * Not even in a dry run, not even on failure. The output is counts and ref codes. A log file on a
 * laptop is exactly the kind of place a sort code should not end up — the same reasoning lib/redact
 * exists for.
 *
 * ── THE PIPE REFUSAL IS WANTED HERE ─────────────────────────────────────────────────────────────
 * _ts.mjs brings in _gate-preflight, which refuses a piped stdout. A SIGPIPE part-way through a
 * column rewrite is half a job on a shared database. Redirect to a file.
 */
import './_ts.mjs';

const { describeError } = await import('./_gate-preflight.mjs');
const { prisma } = await import('../lib/db.ts');
const { encryptPayee, isPayeeEncrypted, payeeLast4, payeeKeyUsable, PAYEE_KEY_ENV } = await import('../lib/payee-crypto.ts');

const WRITE = process.argv.includes('--write');

/**
 * THE KEY IS CHECKED BEFORE ANYTHING IS READ. Without it every encrypt would throw on the first row
 * and leave the earlier ones done — the half-applied state this script exists to end, not create.
 */
if (!payeeKeyUsable()) {
  console.error(`\n  ${PAYEE_KEY_ENV} is missing or is not base64 of 32 bytes, so nothing can be encrypted.`);
  console.error('  Generate one with `openssl rand -base64 32` and put it in .env (and, separately, in Vercel).');
  console.error('  NOTHING HAS BEEN READ OR WRITTEN.\n');
  process.exit(2);
}

const reps = await prisma.rep.findMany({
  where: { NOT: { bank_sort_code: null } },
  select: {
    id: true, ref_code: true, party_type: true,
    bank_sort_code: true, bank_account_number: true, bank_account_last4: true,
  },
  orderBy: { created_at: 'asc' },
});

console.log(`\n  ${WRITE ? 'WRITING' : 'DRY RUN — nothing will be written'}`);
console.log(`  ${reps.length} row(s) hold bank details.\n`);

if (reps.length === 0) {
  // NOTHING TO CHECK IS NOT A CLEAN BILL, and it is worth one explicit line: a reader who sees no
  // output at all cannot tell this from a script that failed to connect.
  console.log('  Nothing to do: no Rep row has a sort code, so there is no plaintext to encrypt.');
  console.log('  That is a positive report, not an empty result.\n');
  await prisma.$disconnect();
  process.exit(0);
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

  // WHAT WOULD CHANGE, named per column, so the dry run is a plan and not a count.
  const plan = [
    sortClear ? 'sort code → encrypted' : null,
    acctClear ? 'account number → encrypted' : null,
    needsLast4 ? 'last four → filled' : null,
  ].filter(Boolean).join(', ');

  if (!WRITE) {
    console.log(`  · ${r.ref_code} (${r.party_type}) — would change: ${plan}`);
    continue;
  }

  try {
    /**
     * THE LAST FOUR COMES FROM WHICHEVER FORM THE ROW IS IN. If the account number is still clear,
     * it is the source; if it is already encrypted and only the last four is missing, there is
     * nothing to derive it from without the key — and that case is reported rather than guessed at,
     * because a wrong last four on a remittance is a plausible wrong value.
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

console.log(`\n  ${WRITE ? `${done} written` : `${reps.length - already} would change`} · ${already} already done · ${failed} failed`);
if (!WRITE) console.log('  Re-run with --write to apply. Nothing was written.');
if (failed) console.log('  SOME ROWS FAILED. Re-running is safe: finished rows are skipped by their v1: envelope.');
console.log('');

await prisma.$disconnect();
process.exit(failed ? 1 : 0);
