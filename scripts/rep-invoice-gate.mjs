/**
 * File: scripts/rep-invoice-gate.mjs
 * THE REP'S INVOICE IS THE REP'S DOCUMENT.
 * @gate-requires: server, db
 *
 * ── WHAT THIS IS ACTUALLY GUARDING ──────────────────────────────────────────────────────────────
 * A rep is self-employed. What they submit is THEIR accounting record and we are its customer, so
 * the failures here are not ours to absorb quietly: charging VAT nobody is registered to charge,
 * two invoices for the same released line, or a document that changes after it was filed are all
 * things a rep's accountant finds and we caused.
 *
 * ── EVERY CLAUSE IS RED-PROVED SEPARATELY ───────────────────────────────────────────────────────
 * The pure rules are proved on constructed inputs, so a boundary can be asked from both sides
 * without moving a clock. The concurrency clause is proved with two REAL submissions racing, not by
 * reading the source for an updateMany — a conditional update is only a conditional update if the
 * losing caller actually loses.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * Its own throwaway Rep and its own CLOSED pay runs, removed by their OWN ids. Commission entries
 * are written against ZZ Gate Garage, never TMBS. Closed runs deliberately: an OPEN one would
 * collide with the platform-wide single-open partial unique index and take out the release screen.
 */
import './_gate-preflight.mjs';
const { gatePrisma, serverReady, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { keyRegex } = await import('../lib/anchored-match.ts');
const { readFileSync, existsSync } = await import('node:fs');
const { randomUUID, createHash } = await import('node:crypto');

const out = [];
const check = (n, ok, dd = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${dd ? `  — ${dd}` : ''}`); };

const prisma = await gatePrisma();
const R = await import('../lib/rep-invoice.ts').catch((e) => ({ __err: describeError(e) }));
const W = await import('../lib/rep-invoice-submit.ts').catch((e) => ({ __err: describeError(e) }));
const src = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const D = (s) => new Date(`${s}T12:00:00.000Z`);

/**
 * ── THE STUB RENDERER, AND WHAT IT DOES NOT PROVE ──────────────────────────────────────────────
 * lib/rep-invoice-pdf is .tsx and node --experimental-strip-types does not transform JSX, so this
 * harness cannot load it. Rather than test a served page instead — the workaround that proved the
 * wrong thing twice before — the renderer is INJECTED for the transaction clauses, which are about
 * money and not about paper, and the real renderer is proved separately over HTTP below.
 *
 * The stub returns REAL BYTES of a plausible length, because RepInvoice_pdf_chk refuses an empty
 * buffer and the hash/length clauses have to have something true to be true about.
 */
const stubPdf = async (doc) => Buffer.from(
  `%PDF-1.7 stub for ${doc.number} ${doc.totalPennies}` + 'x'.repeat(1200), 'utf8');

const made = { reps: [], runs: [], invoices: [], entries: [] };
try {
  await serverReady();
  check('lib/rep-invoice loads', !R.__err, R.__err ?? '');
  check('lib/rep-invoice-submit loads', !W.__err, W.__err ?? '');
  if (R.__err || W.__err) throw new Error(R.__err ?? W.__err);

  // ── 1. THE PROFILE GATES THE FIRST INVOICE — AND THE UTR NEVER DOES ──────────────────────────
  console.log('\n— the profile gates it, and the UTR does not —');
  const full = { trading_name: 'A Rep Ltd', address_line1: '1 Road', address_postcode: 'DY4 7LH', contact_email: 'a@b.test', vat_registered: false };
  check('a complete profile passes', R.profileComplete(full));
  check('  …with vat_registered FALSE, which is an ANSWER', R.missingProfileFields({ ...full, vat_registered: false }).length === 0,
    'false is a settled fact; only null is unanswered');
  check('  …but null VAT is NOT answered', R.missingProfileFields({ ...full, vat_registered: null }).join(',') === 'vat_registered',
    'the three-state column exists so "not asked" and "no" are different refusals');
  check('a missing trading name blocks it', R.missingProfileFields({ ...full, trading_name: null }).includes('trading_name'));
  check('  …and so does a blank one', R.missingProfileFields({ ...full, trading_name: '   ' }).includes('trading_name'),
    'a form that posts spaces must not make a profile complete');
  check('THE UTR IS NOT A REQUIRED FIELD', !R.REQUIRED_PROFILE_FIELDS.includes('utr'),
    'not an invoice requirement — blocking on one would invent a rule HMRC does not have');

  // ── 2. VAT IS A REFUSAL, AND IT MOVES WITH THE EFFECTIVE DATE ────────────────────────────────
  console.log('\n— VAT is refused, not omitted —');
  const unreg = { vat_registered: false, vat_effective_from: null };
  const reg = { vat_registered: true, vat_effective_from: D('2026-08-01') };
  check('an unregistered rep gets a REFUSAL with a reason', R.refuseVat(unreg, D('2026-09-01'))?.code === 'not_vat_registered',
    'a refusal, not a silently-absent VAT block — the difference is one edit away from charging it');
  check('  …and vatAppliesTo agrees', R.vatAppliesTo(unreg, D('2026-09-01')) === false);
  check('a registered rep AFTER the effective date carries VAT', R.vatAppliesTo(reg, D('2026-09-01')) === true);
  check('  …and ON the effective date does too', R.vatAppliesTo(reg, D('2026-08-01')) === true, 'the boundary is inclusive');
  check('  …but BEFORE it does not', R.vatAppliesTo(reg, D('2026-07-31')) === false,
    'registering must not retrospectively add VAT to a period that was never VATable');
  check('  …and that refusal says WHY it is different', R.refuseVat(reg, D('2026-07-31'))?.code === 'before_vat_registration',
    'two refusals, two different things for the rep to do about them');

  // THE SAME REP, TWO DOCUMENTS, ONE BOUNDARY. This is the clause the effective date exists for.
  const repRow = {
    ...full, vat_registered: true, vat_number: 'GB123456789', vat_effective_from: D('2026-08-01'),
    address_line2: null, address_locality: 'Tipton', address_region: null,
    bank_account_name: null, bank_sort_code: null, bank_account_number: null,
  };
  const line = [{ period: '2026-07', isArrears: false, garage: 'ZZ', description: 'Sales Commission', amountPennies: 10000 }];
  const before = R.buildRepInvoiceDoc({ rep: repRow, number: '001', invoiceDate: D('2026-07-31'), currency: 'GBP', lines: line });
  const after = R.buildRepInvoiceDoc({ rep: repRow, number: '002', invoiceDate: D('2026-08-01'), currency: 'GBP', lines: line });
  check('the SAME rep renders differently either side of the date',
    before.vatApplied === false && after.vatApplied === true, `${before.totalPennies} vs ${after.totalPennies}`);
  check('  …the earlier one states no VAT number', before.from.vatNumber === null && after.from.vatNumber === 'GB123456789');
  check('  …and no tax point', before.taxPoint === null && after.taxPoint !== null,
    'a document that is not a VAT invoice has no tax point to print');
  check('  …and the totals differ by exactly the VAT', after.totalPennies - before.totalPennies === 2000,
    `${before.totalPennies} → ${after.totalPennies}`);

  // ── 3. HONEST NULL ON THE DOCUMENT ───────────────────────────────────────────────────────────
  console.log('\n— what is missing reads as missing —');
  check('no bank details render as absent, not as zeros', after.payTo === null,
    'never a blank block that reads as filled in, and never a zeroed account');
  const banked = R.buildRepInvoiceDoc({ rep: { ...repRow, bank_account_name: 'A Rep Ltd', bank_sort_code: '00-00-00', bank_account_number: '12345678' }, number: '3', invoiceDate: D('2026-09-01'), currency: 'GBP', lines: line });
  check('  …and present ones render', banked.payTo?.sortCode === '00-00-00');
  check('a first-time rep gets NO prefilled number', R.nextInvoiceNumber(null) === null,
    'their series is theirs; guessing at it is worse than an empty box');
  check('  …and a returning one gets last plus one, padded', R.nextInvoiceNumber('001') === '002' && R.nextInvoiceNumber('GD-2026-14') === 'GD-2026-15');

  // ── 4. THE REP-FACING READ CANNOT CARRY THE MANAGER'S ASSESSMENT ─────────────────────────────
  console.log('\n— a rep never sees what the area manager wrote about them —');
  const PRIVATE = ['held_reason', 'release_override_reason', 'shown_as_visited'];
  const shaped = R.repVisibleLine({ period: '2026-05', amount_pennies: 3500, held_reason: 'evidence_queried', release_override_reason: 'garage_onboarding_month', shown_as_visited: false }, 'ZZ', '2026-07');
  const leaked = PRIVATE.filter((k) => k in shaped);
  check('the shaped line carries none of the three', leaked.length === 0, leaked.join(', ') || Object.keys(shaped).join(', '));
  check('  …and it still carries what a rep needs', shaped.amountPennies === 3500 && shaped.isArrears === true,
    'absent, not blanked — the omission is the mechanism');
  // AND THE PAGE MUST USE IT. A shaper nothing calls is a shaper that proves nothing.
  const repPages = ['pages/rep/index.tsx', 'pages/rep/runs/[id].tsx'];
  for (const p of repPages) {
    const s = code(src(p));
    check(`${p} selects no private column`, !PRIVATE.some((k) => s.includes(k)),
      PRIVATE.filter((k) => s.includes(k)).join(', ') || 'none of the three appears in the file at all');
  }

  // ── 5. THE DOCUMENT IS FROZEN ────────────────────────────────────────────────────────────────
  console.log('\n— submitted is submitted —');
  check('refuseIfSubmitted refuses, always', R.refuseIfSubmitted({ id: 'x', status: 'pending_review' })?.code === 'submitted');
  check('  …for every status, because submission IS creation',
    ['pending_review', 'approved', 'paid', 'rejected', 'cancelled'].every((s) => R.refuseIfSubmitted({ id: 'x', status: s })),
    'there is no draft, so there is no state in which this document may still change');
  const pdfSrc = src('lib/rep-invoice-pdf.tsx');
  check('the renderer reads the SHARED VAT rule', /showVatTotalLine/.test(code(pdfSrc)),
    'the same rule the other three renderers read, not a fourth copy of it');
  const submitSrc = code(src('lib/rep-invoice-submit.ts'));
  check('nothing re-renders a stored invoice', !/renderRepInvoicePdf/.test(submitSrc.split('storedRepInvoicePdf')[1] ?? ''),
    'the read path returns BYTES; a regenerate would be forging somebody else’s books');
  // PRODUCTION PASSES NO RENDERER, so it gets the real one. If an API route ever injected its own,
  // every clause below would be testing a document nobody ships.
  const apiSrc = code(src('pages/api/rep/invoice.ts'));
  check('the production caller injects NO renderer', apiSrc.length > 0 && !keyRegex('render').test(apiSrc),
    apiSrc.length ? 'submitRepInvoice is called without one, so the default .tsx renderer runs' : 'pages/api/rep/invoice.ts does not exist');
  check('  …and the claim is conditional on the pre-state, counted',
    keyRegex('status', "'released', rep_invoice_id: null").test(submitSrc) && /claimed\.count !== locked\.length/.test(submitSrc),
    'not a unique index with a caught P2002 — see the named fact in schema.prisma');

  // ── 6. THE REAL THING, AGAINST THE REAL DATABASE ─────────────────────────────────────────────
  console.log('\n— and now for real —');
  const mkRep = async (over = {}) => {
    const r = await prisma.rep.create({ data: {
      email: `rep-inv-gate-${randomUUID()}@greasedesk.invalid`, name: 'Invoice Gate Rep',
      ref_code: `RIG${randomUUID().slice(0, 8)}`,
      trading_name: 'Gate Rep Ltd', address_line1: '1 Road', address_postcode: 'DY4 7LH',
      contact_email: 'gate@rep.invalid', vat_registered: false, ...over,
    }, select: { id: true } });
    made.reps.push(r.id); return r.id;
  };
  const mkRun = async (period) => {
    const r = await prisma.repPayRun.create({ data: {
      period, scheduled_on: D('2026-08-25'), status: 'closed', closed_at: D('2026-08-26'),
      closed_by: 'invoice-gate', signoff: 'gate fixture',
      snapshot_parties: 1, snapshot_line_count: 1, snapshot_amount_pennies: 3500,
    }, select: { id: true } });
    made.runs.push(r.id); return r.id;
  };
  const mkEntry = async (runId, repId, period, pennies) => {
    const e = await prisma.commissionEntry.create({ data: {
      group_id: ZZ_GROUP, party_type: 'rep', party_id: repId, period, kind: 'accrual', tier: 'thereafter',
      rate_id: `gate-${randomUUID().slice(0, 8)}`, share_bp: 0, amount_pennies: pennies, currency: 'GBP',
      source_ref: `rig-${randomUUID()}`, payment_ref: `rig-${randomUUID()}`,
      status: 'released', pay_run_id: runId, released_at: D('2026-08-26'), released_by: 'invoice-gate',
      shown_as_visited: true,
    }, select: { id: true } });
    made.entries.push(e.id); return e.id;
  };

  const repA = await mkRep();
  const runA = await mkRun('2026-08');
  await mkEntry(runA, repA, '2026-08', 3500);
  await mkEntry(runA, repA, '2026-05', 1500);   // arrears

  const first = await W.submitRepInvoice({ render: stubPdf, repId: repA, payRunId: runA, number: '001' });
  if (first.ok) made.invoices.push(first.invoiceId);
  check('a rep can submit an invoice for a closed run', first.ok === true, JSON.stringify(first));
  const row = first.ok ? await prisma.repInvoice.findUnique({ where: { id: first.invoiceId }, include: { lines: true } }) : null;
  check('  …the PDF bytes are stored', (row?.pdf_bytes ?? 0) > 1000, `${row?.pdf_bytes} bytes`);
  check('  …and the hash is the hash OF THOSE BYTES', row
    && createHash('sha256').update(Uint8Array.from(row.pdf)).digest('hex') === row.pdf_sha256,
    'hashing a re-render would hash a second document that merely resembles the first');
  check('  …the lines are SNAPSHOT onto it', (row?.lines.length ?? 0) === 2 && row.lines.some((l) => l.is_arrears),
    `${row?.lines.length} line(s), arrears marked with its own period`);
  check('  …and the entries are now billed to it', await (async () => {
    const es = await prisma.commissionEntry.findMany({ where: { rep_invoice_id: first.invoiceId }, select: { status: true } });
    return es.length === 2 && es.every((e) => e.status === 'billed');
  })());
  check('  …with no VAT, because this rep is not registered', row?.vat_applied === false && row?.vat_pennies === null,
    'the database refuses the other shape too — RepInvoice_vat_chk');

  // A SECOND SUBMISSION FOR THE SAME RUN. The lines are gone, so there is nothing to invoice.
  const second = await W.submitRepInvoice({ render: stubPdf, repId: repA, payRunId: runA, number: '002' });
  check('a released line cannot reach a SECOND invoice', second.ok === false && second.code === 'no_lines',
    JSON.stringify(second));

  // ── THE NUMBER IS THEIRS, NOT OURS ───────────────────────────────────────────────────────────
  const runB = await mkRun('2026-09');
  await mkEntry(runB, repA, '2026-09', 2500);
  const dupe = await W.submitRepInvoice({ render: stubPdf, repId: repA, payRunId: runB, number: '001' });
  check('the SAME rep may not reuse their own number', dupe.ok === false && dupe.code === 'number_used', JSON.stringify(dupe));

  const repB = await mkRep();
  await mkEntry(runB, repB, '2026-09', 2500);
  const other = await W.submitRepInvoice({ render: stubPdf, repId: repB, payRunId: runB, number: '001' });
  if (other.ok) made.invoices.push(other.invoiceId);
  check('  …but a DIFFERENT rep may use 001', other.ok === true,
    'two businesses, two sales ledgers, neither has heard of the other');

  // ── CONCURRENCY, FOR REAL ────────────────────────────────────────────────────────────────────
  const runC = await mkRun('2026-10');
  const repC = await mkRep();
  await mkEntry(runC, repC, '2026-10', 4500);
  const [r1, r2] = await Promise.all([
    W.submitRepInvoice({ render: stubPdf, repId: repC, payRunId: runC, number: 'C1' }),
    W.submitRepInvoice({ render: stubPdf, repId: repC, payRunId: runC, number: 'C2' }),
  ]);
  for (const r of [r1, r2]) if (r.ok) made.invoices.push(r.invoiceId);
  const wins = [r1, r2].filter((r) => r.ok).length;
  check('two simultaneous submissions produce exactly ONE invoice', wins === 1,
    `${wins} succeeded — ${JSON.stringify([r1, r2].map((r) => (r.ok ? 'ok' : r.code)))}`);
  check('  …and the line is billed exactly once', await (async () => {
    const es = await prisma.commissionEntry.findMany({ where: { pay_run_id: runC }, select: { rep_invoice_id: true, status: true } });
    return es.length === 1 && es[0].status === 'billed' && es[0].rep_invoice_id !== null;
  })());

  // ── HONEST NULL, AGAINST THE DATABASE ────────────────────────────────────────────────────────
  const runD = await mkRun('2026-11');
  const empty = await W.submitRepInvoice({ render: stubPdf, repId: repA, payRunId: runD, number: 'D1' });
  check('a run with nothing released is NO invoice, not a £0.00 one', empty.ok === false && empty.code === 'no_lines',
    'a zero document would be a demand for nothing, with a number spent on it');

  const bare = await mkRep({ trading_name: null });
  const runE = await mkRun('2026-12');
  await mkEntry(runE, bare, '2026-12', 1000);
  const blocked = await W.submitRepInvoice({ render: stubPdf, repId: bare, payRunId: runE, number: 'E1' });
  check('an incomplete profile blocks the first invoice', blocked.ok === false && blocked.code === 'profile_incomplete',
    blocked.ok ? 'submitted anyway' : blocked.message);
  await prisma.rep.update({ where: { id: bare }, data: { trading_name: 'Now Complete Ltd' } });
  const unblocked = await W.submitRepInvoice({ render: stubPdf, repId: bare, payRunId: runE, number: 'E1' });
  if (unblocked.ok) made.invoices.push(unblocked.invoiceId);
  check('  …and completing it unblocks them, with NO utr anywhere', unblocked.ok === true,
    unblocked.ok ? 'submitted with utr still null' : unblocked.message);

  // ── 7. THE REAL RENDERER, DRIVEN THE WAY A REP DRIVES IT ─────────────────────────────────────
  // Everything above injected a stub, because this harness cannot load JSX. That leaves one thing
  // unproved and it is not a small one: whether the document a rep actually receives is a document.
  // So one submission goes the whole way — sign in with a real magic link, open the run, type a
  // number, press submit — through Next, which compiles the .tsx exactly as production does.
  //
  // Reached the way a rep reaches it, deliberately. Calling the API with a forged cookie would
  // prove the renderer and skip the page that decides what is sent to it.
  console.log('\n— and the document a rep actually receives —');
  const { repOrigin, REP_RESOLVER_ARGS } = await import('./_gate-preflight.mjs');
  const RM = await import('../lib/rep-magic-link.ts');
  const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
  const repF = await mkRep({ vat_registered: true, vat_number: 'GB999999999', vat_effective_from: D('2026-01-01') });
  const runF = await mkRun('2027-01');
  await mkEntry(runF, repF, '2027-01', 6000);
  const REP_BASE = repOrigin();
  const link = await RM.mintRepLink({ repId: repF, sentTo: 'gate@rep.invalid', baseUrl: REP_BASE });
  let br = null;
  try {
    br = await chromium.launch({ channel: 'chrome', args: [...REP_RESOLVER_ARGS, '--host-resolver-rules=MAP reps.greasedesk.com 127.0.0.1'] });
    const ctx = await br.newContext();
    const pg = await ctx.newPage();
    const pageErrors = [];
    pg.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
    await pg.goto(link.url, { waitUntil: 'domcontentloaded' });
    await pg.click('[data-testid="rep-enter"]');
    await pg.waitForSelector('[data-testid="rep-home"]');
    await pg.goto(`${REP_BASE}/rep/runs/${runF}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('[data-testid="rep-invoice-form"]');
    check('a registered rep is shown the VAT before they submit', await pg.locator('[data-testid="rep-vat"]').count() === 1,
      'the figure on the screen is the figure on the paper — same date, same rule');
    await pg.fill('[data-testid="rep-number"]', 'REAL-001');
    await pg.click('[data-testid="rep-submit"]');
    await pg.waitForSelector('[data-testid="rep-run-invoice"]');
    check('the whole path renders without throwing', pageErrors.length === 0, pageErrors[0] ?? 'no uncaught error');

    const real = await prisma.repInvoice.findFirst({ where: { rep_id: repF }, select: { id: true, pdf: true, pdf_bytes: true, pdf_sha256: true, vat_applied: true, vat_pennies: true } });
    if (real) made.invoices.push(real.id);
    const head = real ? Buffer.from(real.pdf.slice(0, 8)).toString('latin1') : '';
    check('the stored bytes are a real PDF', head.startsWith('%PDF-'), `${head.trim()} · ${real?.pdf_bytes} bytes`);
    check('  …produced by the REAL renderer, not the stub', real != null && real.pdf_bytes > 2000
      && !Buffer.from(real.pdf).toString('latin1').includes('stub for'),
      'the stub is 1226 bytes of padding and says so; a real @react-pdf document is larger and does not');
    check('  …with the hash of exactly those bytes', real
      && createHash('sha256').update(Uint8Array.from(real.pdf)).digest('hex') === real.pdf_sha256);
    check('  …and VAT on it, because this rep IS registered', real?.vat_applied === true && real.vat_pennies === 1200,
      `vat_applied=${real?.vat_applied} vat=${real?.vat_pennies}`);

    // AND IT IS SERVED FROM STORAGE, NOT RE-RENDERED.
    const served = await pg.goto(`${REP_BASE}/api/rep/invoice-pdf?id=${real.id}`, { waitUntil: 'domcontentloaded' });
    check('the rep can fetch their own stored document', served.status() === 200
      && /application\/pdf/.test(served.headers()['content-type'] ?? ''), `${served.status()} ${served.headers()['content-type']}`);
    check('  …byte-for-byte what was stored', Number(served.headers()['content-length']) === real.pdf_bytes,
      'served from the column; nothing on this path can re-render it');
  } finally {
    try { await br?.close(); } catch {}
  }

} catch (e) {
  check('run completed', false, describeError(e));
} finally {
  // BY THEIR OWN IDS, INNERMOST FIRST. Lines cascade from the invoice; entries RESTRICT it, so the
  // entries are unpointed before the invoices go.
  try {
    if (made.entries.length) await prisma.commissionEntry.updateMany({ where: { id: { in: made.entries } }, data: { rep_invoice_id: null, status: 'released' } });
    for (const id of made.invoices) await prisma.repInvoice.delete({ where: { id } }).catch((e) => console.log('teardown invoice:', String(e).slice(0, 80)));
    if (made.entries.length) await prisma.commissionEntry.deleteMany({ where: { id: { in: made.entries } } });
    for (const id of made.runs) await prisma.repPayRun.delete({ where: { id } }).catch((e) => console.log('teardown run:', String(e).slice(0, 80)));
    for (const id of made.reps) await prisma.rep.delete({ where: { id } }).catch((e) => console.log('teardown rep:', String(e).slice(0, 80)));
    const left = await prisma.commissionEntry.count({ where: { id: { in: made.entries } } });
    const leftInv = await prisma.repInvoice.count({ where: { rep_id: { in: made.reps } } });
    check('teardown removed every fixture', left === 0 && leftInv === 0, `${left} entr(ies), ${leftInv} invoice(s) left`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
