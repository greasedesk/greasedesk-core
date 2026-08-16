/**
 * File: scripts/poisoned-transaction-gate.mjs
 * A CAUGHT P2002 STILL POISONS ITS TRANSACTION. This gate finds the shape, not the sites.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * Postgres aborts the entire transaction on any failed statement. So catching P2002 inside a
 * $transaction and carrying on is not idempotence — every command after the catch dies with 25P02
 * (in_failed_sql_transaction). On 2026-08-16 that turned an ordinary double-tap on Pay into "the
 * payment couldn't be started just now", against an intent that was perfectly fine.
 *
 * ── WHY A SCANNER RATHER THAN FOUR ASSERTIONS ───────────────────────────────────────────────────
 * Four occurrences were found by hand. Asserting those four proves the four are fixed and says
 * nothing about the fifth, which someone writes next month because the pattern reads as obviously
 * correct. This walks every $transaction block in lib/ and pages/api/ and fails on the SHAPE:
 *
 *     $transaction(async (tx) => {
 *        …
 *        catch { if (code === 'P2002') … }    ← swallowed
 *        await tx.something(...)              ← and then more work. 25P02.
 *     })
 *
 * ── IT IS PROVEN RED ────────────────────────────────────────────────────────────────────────────
 * The scanner runs against a synthetic file containing the ORIGINAL code before it runs against the
 * tree. A detector that has never detected anything is not a detector.
 */
import './_ts.mjs';
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

/** Every .ts/.tsx under a root, recursively. */
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p, acc); }
    else if (/\.tsx?$/.test(e)) acc.push(p);
  }
  return acc;
}

/**
 * Find `$transaction(` callback bodies by brace matching, then look inside each for a swallowed
 * P2002 with work after it. Brace matching rather than a regex because a regex cannot tell where a
 * block ends, and "is there work AFTER the catch but STILL INSIDE the transaction" is the whole
 * question being asked.
 */
function findPoisonedBlocks(src) {
  const hits = [];
  let i = 0;
  while ((i = src.indexOf('$transaction(', i)) !== -1) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    let depth = 0, end = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    const body = src.slice(open, end);

    // A swallowed P2002: the code is compared and the error is NOT rethrown on that branch.
    const p2002 = body.search(/P2002/);
    if (p2002 !== -1) {
      const after = body.slice(p2002);
      const swallowed = !/P2002['"]\s*\)?\s*\)?\s*throw/.test(after) && !/!==\s*['"]P2002['"]\s*\)?\s*throw/.test(after);
      // Work after the catch, still inside the transaction body.
      const catchEnd = after.indexOf('}');
      const rest = catchEnd === -1 ? '' : after.slice(catchEnd);
      const moreWork = /await\s+(tx|\(tx)/.test(rest);
      if (swallowed && moreWork) {
        hits.push({ at: src.slice(0, i).split('\n').length, snippet: body.slice(Math.max(0, p2002 - 60), p2002 + 120).replace(/\s+/g, ' ') });
      }
    }
    i = end;
  }
  return hits;
}

try {
  // ── 1. THE DETECTOR MUST DETECT ────────────────────────────────────────────────────────────
  console.log('\n— proving the scanner goes red —');
  const tmp = mkdtempSync(join(tmpdir(), 'poison-'));
  const bad = join(tmp, 'bad.ts');
  // THE ORIGINAL CODE, verbatim in shape: recordPayment swallows P2002, updateMany follows.
  writeFileSync(bad, `
    await prisma.$transaction(async (tx) => {
      try {
        await tx.payment.create({ data: {} });
      } catch (e) {
        if (e?.code === 'P2002') return null;
        throw e;
      }
      await tx.payment.updateMany({ where: {}, data: {} });
    });
  `);
  const badHits = findPoisonedBlocks(readFileSync(bad, 'utf8'));
  check('the original shape is FLAGGED', badHits.length === 1, 'a detector that never detected anything is not a detector');

  const good = join(tmp, 'good.ts');
  // The correct shape: the catch is OUTSIDE, so the duplicate rolls the transaction back cleanly.
  writeFileSync(good, `
    try {
      await prisma.$transaction(async (tx) => {
        await tx.refund.create({ data: {} });
        await reconcileInvoice(tx, id);
      });
    } catch (e) {
      if (e?.code !== 'P2002') throw e;
    }
  `);
  check('the CORRECT shape is not flagged', findPoisonedBlocks(readFileSync(good, 'utf8')).length === 0,
    'catching outside the transaction is the fix, and must not read as the defect');
  rmSync(tmp, { recursive: true, force: true });

  // ── 2. THE TREE ────────────────────────────────────────────────────────────────────────────
  console.log('\n— scanning lib/ and pages/api/ —');
  const files = [...walk('lib'), ...walk('pages/api')];
  const found = [];
  for (const f of files) {
    for (const h of findPoisonedBlocks(readFileSync(f, 'utf8'))) found.push({ file: f, ...h });
  }
  for (const h of found) console.log(`    ${h.file}:${h.at}  ${h.snippet.slice(0, 100)}`);
  check(`no swallowed P2002 with work after it, anywhere`, found.length === 0,
    `${files.length} files scanned${found.length ? ` — ${found.length} occurrence(s)` : ''}`);

  // ── 3. THE STRUCTURAL RULES THAT REPLACED THE COMMENTS ─────────────────────────────────────
  console.log('\n— rules, not requests —');
  const payments = readFileSync('lib/payments.ts', 'utf8');
  check('recordManualPayment exists and takes NO sourceRef', /recordManualPayment\(tx: Tx, args: Omit<RecordPaymentArgs, 'sourceRef'>\)/.test(payments),
    'the unsafe call is unwritable at the counter paths, not merely discouraged');
  const jobcard = readFileSync('pages/api/jobcard-status.ts', 'utf8');
  check('jobcard-status uses only the manual entry point', !/\brecordPayment\(/.test(jobcard) && /recordManualPayment\(/.test(jobcard),
    'it was safe only because nobody had passed a sourceRef — correct by accident');
  const commission = readFileSync('lib/commission.ts', 'utf8');
  check('commission requires a ROOT client, not any client', /type RootClient = Db & \{ \$transaction: unknown \}/.test(commission)
    && /insertIdempotent\(db: RootClient/.test(commission),
    'TransactionClient lacks $transaction, so the type rejects one — a comment is a request, a type is a rule');
  check('and both looping callers are typed the same way',
    /accruePayment\(db: RootClient/.test(commission) && /clawbackRefund\(db: RootClient/.test(commission));

  // ── 4. THE SECOND CONSEQUENCE ──────────────────────────────────────────────────────────────
  console.log('\n— the cache on the duplicate path —');
  const intent = readFileSync('lib/invoice-payment-intent.ts', 'utf8');
  check('the fee grain is written OUTSIDE the transaction', /\}\s*\n\s*\/\/ Fee grain[\s\S]{0,400}prisma\.payment\.updateMany/.test(intent),
    'so a duplicate bind no longer takes the update down with it');
  check('and a duplicate is recognised rather than reported as a failure',
    /firstBind = false/.test(intent) && /was already bound — a repeat press, not an error/.test(intent));
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  process.exit(out.includes('F') ? 1 : 0);
}
