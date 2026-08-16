/**
 * File: scripts/account-terms-gate.mjs
 * Account customers: does the due date freeze, and does "overdue" discriminate?
 *
 * The pure rules are proved with no database at all (standing rule 1 — a property of the
 * assertions, not of any write). The DB half then uses ONE throwaway customer on the gate tenant,
 * and asserts up front that it owns nothing else.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { dueDateFor, normaliseTermsDays, isAccountCustomer, overdueWhere, daysOverdue, MAX_TERMS_DAYS } = await import('../lib/account-terms.ts');
const { listWhere, LIST_STATUS_KEYS, isListStatusKey } = await import('../lib/invoice-list-filters.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const DAY = 86_400_000;
const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';

// ── PURE: NULL IS RETAIL, AND RETAIL CANNOT BE LATE ────────────────────────────────────────────
const issued = new Date('2026-06-01T16:00:00Z');
check('no terms → NO due date (pays on collection)', dueDateFor({ account_terms_days: null }, issued) === null);
check('a missing customer → no due date', dueDateFor(null, issued) === null);
check('30 days → thirty days later, to the hour',
  dueDateFor({ account_terms_days: 30 }, issued)?.toISOString() === new Date(issued.getTime() + 30 * DAY).toISOString(),
  dueDateFor({ account_terms_days: 30 }, issued)?.toISOString());
check('zero days is NOT an account — that is collection', normaliseTermsDays(0) === null);
check('a negative is refused, not stored', normaliseTermsDays(-30) === null);
check('nonsense is refused', normaliseTermsDays('thirty') === null && normaliseTermsDays('') === null);
check(`beyond ${MAX_TERMS_DAYS} days is a loan, not an invoice`, normaliseTermsDays(365) === null);
check('30 survives as 30', normaliseTermsDays('30') === 30);
check('the flag IS the terms', isAccountCustomer({ account_terms_days: 30 }) && !isAccountCustomer({ account_terms_days: null }));
check('no due date → never overdue, however old', daysOverdue({ due_date: null, status: 'issued' }, new Date('2030-01-01')) === null);
check('a paid invoice past its date is not overdue', daysOverdue({ due_date: new Date('2026-01-01'), status: 'paid' }) === null);
check('an unpaid one past its date IS overdue', daysOverdue({ due_date: new Date(Date.now() - 5 * DAY), status: 'issued' }) === 5);

// ── PURE: THE FILTER ───────────────────────────────────────────────────────────────────────────
check('overdue is a listable key', isListStatusKey('overdue') && LIST_STATUS_KEYS.includes('overdue'));
const ow = listWhere('overdue', null).where;
check('overdue EXCLUDES a null due date — the whole back catalogue', ow.due_date?.not === null, JSON.stringify(ow.due_date));
check('overdue keeps the chaser exclusions (imported, chargeable)', ow.is_imported === false && ow.series === 'chargeable');
check('overdue only ever means UNPAID', ow.status === 'issued');
const t1 = listWhere('overdue', null).where.due_date.lt;
await new Promise((r) => setTimeout(r, 15));
check('the clock is re-read per call, not frozen at module load',
  listWhere('overdue', null).where.due_date.lt.getTime() > t1.getTime());
// And the fail-check: a predicate that DROPPED the null exclusion would sweep the back catalogue.
const BROKEN = { status: 'issued', due_date: { lt: new Date() } };
check('… and the assertion above would CATCH a predicate missing it', BROKEN.due_date.not === undefined,
  'no DB needed — the discrimination is a property of the assertion');

// ── DB: ONE THROWAWAY CUSTOMER, ON THE GATE TENANT ─────────────────────────────────────────────
const stamp = `zz-terms-${Date.now()}`;
let custId = null;
try {
  const mine = await prisma.customer.count({ where: { group_id: ZZ, name: { startsWith: 'ZZ Terms Fixture' } } });
  if (mine > 0) { console.log(`\nREFUSING — ${mine} fixture customers already on ZZ; clean them first.`); process.exit(2); }

  const c = await prisma.customer.create({ data: { group_id: ZZ, name: `ZZ Terms Fixture ${stamp}`, account_terms_days: 30, account_name: 'ZZ Haulage Ltd' }, select: { id: true, account_terms_days: true } });
  custId = c.id;
  check('terms persist on the customer', c.account_terms_days === 30, String(c.account_terms_days));
  const read = await prisma.customer.findUnique({ where: { id: c.id }, select: { account_terms_days: true, account_name: true } });
  check('and read back', read.account_terms_days === 30 && read.account_name === 'ZZ Haulage Ltd');
  const cleared = await prisma.customer.update({ where: { id: c.id }, data: { account_terms_days: normaliseTermsDays('') }, select: { account_terms_days: true } });
  check('clearing the field takes them OFF account (null, not 0)', cleared.account_terms_days === null, String(cleared.account_terms_days));

  // The real ledger must be untouched by all of this.
  const backCatalogue = await prisma.invoice.count({ where: { group_id: ZZ, due_date: { not: null } } });
  check('no existing ZZ invoice acquired a due date', backCatalogue === 0, `${backCatalogue} with a due date`);
  const overdueNow = await prisma.invoice.count({ where: { group_id: ZZ, ...listWhere('overdue', null).where } });
  check('nothing on ZZ is overdue on deploy day', overdueNow === 0, `${overdueNow}`);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 200));
} finally {
  if (custId) await prisma.customer.delete({ where: { id: custId } }).catch(() => {});
  const left = await prisma.customer.count({ where: { group_id: ZZ, name: { startsWith: 'ZZ Terms Fixture' } } });
  console.log(`\nfixtures left: ${left}`);
  console.log(`${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
