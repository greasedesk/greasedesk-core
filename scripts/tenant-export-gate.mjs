/**
 * File: scripts/tenant-export-gate.mjs
 * @gate-requires: db
 *
 * A TENANT'S OWN COPY OF ITS DATA — the rules that decide what a cell, a filename and an ordering
 * are, checked against planted cases rather than against an export that happens to come out right.
 *
 * The clause this gate exists for is the one nobody would notice failing: an export is read ONCE,
 * months later, by somebody who has left GreaseDesk and cannot ask. A cell that silently became a
 * formula, a photo that overwrote another, a model that was never visited — none of those announce
 * themselves, and all three are only ever found by somebody who needed the data.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const XP = 'ZZEXP';

let prisma;
try {
  const E = await import(`${R}/lib/tenant-export.ts`);
  const M = await import(`${R}/lib/tenant-manifest.ts`);

  console.log('— ONE VALUE, ONE CELL —');
  check('a null is an EMPTY cell, never the word null', E.csvCell(null) === '' && E.csvCell(undefined) === '');
  check('  …so a customer actually called "null" stays distinguishable from one', E.csvCell('null') === 'null');
  check('a date is ISO 8601 UTC, not a local format that reads differently either side of the Atlantic',
    E.csvCell(new Date('2026-10-11T14:30:00.000Z')) === '2026-10-11T14:30:00.000Z');
  check('a bigint is digits', E.csvCell(48234567n) === '48234567');
  check('a boolean is true/false', E.csvCell(true) === 'true' && E.csvCell(false) === 'false');
  /** Every quantity, unit price and line total in the export is a Prisma Decimal. */
  const { Prisma } = await import('@prisma/client');
  const dec = new Prisma.Decimal('1250.75');
  check('a Decimal is a plain number, not a re-quoted JSON string',
    E.csvCell(dec) === '1250.75', `${E.csvCell(dec)} (JSON.stringify would give ${JSON.stringify(dec)})`);
  check('  …and a negative one stays arithmetic rather than being read as a formula',
    E.csvCell(new Prisma.Decimal('-1250.75')) === '-1250.75', E.csvCell(new Prisma.Decimal('-1250.75')));
  check('a JSON column stays JSON in one cell rather than inventing a flattening',
    E.csvCell({ invoices: 7 }) === '"{""invoices"":7}"', E.csvCell({ invoices: 7 }));

  console.log('\n— RFC 4180 —');
  check('a comma is quoted', E.csvCell('Smith, John') === '"Smith, John"');
  check('a quote is doubled and wrapped', E.csvCell('5" bolt') === '"5"" bolt"', E.csvCell('5" bolt'));
  check('a newline is quoted, so a multi-line note cannot end the row early',
    E.csvCell('line one\nline two') === '"line one\nline two"');
  check('a plain value is not quoted for no reason', E.csvCell('BMW 114') === 'BMW 114');

  /**
   * THE ONE THAT MATTERS. Every string in an export was typed by somebody — a customer name, a job
   * note, a part description — and Excel runs a cell beginning = + @ as a formula. An export of
   * customer-entered text, handed to the garage that asked for its own data, is an execution vector.
   */
  console.log('\n— A CELL A GARAGE OPENS MUST NOT RUN —');
  check('a formula is neutralised', E.csvCell('=SUM(A1:A9)') === "'=SUM(A1:A9)", E.csvCell('=SUM(A1:A9)'));
  check('  …including the @ and + forms', E.csvCell('@SUM(1)') === "'@SUM(1)" && E.csvCell('+1+1') === "'+1+1",
    `${E.csvCell('@SUM(1)')} · ${E.csvCell('+1+1')}`);
  // Asserted on the NEUTRALISER, because csvCell also RFC-quotes a cell containing a CR — so the
  // apostrophe ends up inside the quotes and a startsWith check would fail on a correct value.
  check('  …and a leading tab or carriage return, which smuggles one past a naive check',
    E.neutraliseFormula('\t=SUM(1)') === "'\t=SUM(1)" && E.neutraliseFormula('\r=cmd') === "'\r=cmd"
    && E.csvCell('\r=cmd') === '"\'\r=cmd"', E.csvCell('\r=cmd'));
  /** THE PAIR. A blanket rule on the leading minus would quote every credit note in the export. */
  check('  …while a NEGATIVE NUMBER stays arithmetic, because -1250.00 is a credit note',
    E.csvCell('-1250.00') === '-1250.00' && E.csvCell(-1250) === '-1250' && E.csvCell('-1.5e3') === '-1.5e3',
    'the rule is "not a number AND starts dangerous", not "starts with punctuation"');
  check('  …and a formula hidden behind a minus is still caught', E.csvCell('-1+SUM(A1)') === "'-1+SUM(A1)", E.csvCell('-1+SUM(A1)'));

  console.log('\n— A FILE, NOT A CELL —');
  const csv = E.toCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: null }]);
  check('rows are CRLF-terminated, which is what Excel on Windows reads without complaint',
    csv === 'a,b\r\n1,x\r\n,\r\n', JSON.stringify(csv));
  check('a key missing from a row is an empty cell, not the string undefined', !/undefined/.test(csv));
  check('the BOM is there, so an é in a name does not arrive as Ã©', E.CSV_BOM === '﻿');

  console.log('\n— THE ORDER, AS A CLOSURE —');
  const ent = (model, reach, take = 'export') => ({ model, reach, take });
  const simple = E.exportOrder([
    ent('Group', { by: 'self' }), ent('Invoice', { by: 'group' }),
    ent('InvoiceLine', { by: 'parent', through: 'Invoice' }),
    ent('Secret', { by: 'subject', keyedOn: 'subject_id' }, 'omit'),
  ]);
  check('a child comes after its parent', simple.indexOf('InvoiceLine') > simple.indexOf('Invoice'), simple.join(' → '));
  check('  …and an omitted model is not in the order at all', !simple.includes('Secret'));
  const deep = E.exportOrder([
    ent('Group', { by: 'self' }), ent('StagedInvoice', { by: 'group' }),
    ent('StagedLine', { by: 'parent', through: 'StagedInvoice' }),
  ]);
  check('a grandchild two levels down is still reached', deep.indexOf('StagedLine') > deep.indexOf('StagedInvoice'), deep.join(' → '));

  /** AN UNREACHED MODEL IS THROWN, NOT WARNED ABOUT — a warning in a log is a silent omission with
   *  extra steps, and this is the exact failure the whole slice exists to prevent. */
  let threw = null;
  try { E.exportOrder([ent('Group', { by: 'self' }), ent('Orphan', { by: 'parent', through: 'Nowhere' })]); }
  catch (e) { threw = e.message; }
  check('a model whose parent is not exported REFUSES the whole export', !!threw, (threw ?? 'ACCEPTED SILENTLY').slice(0, 90));
  check('  …and the refusal names the model and says the parent is not exported',
    !!threw && /Orphan/.test(threw) && /not exported/.test(threw) && /omit them silently/.test(threw));
  let cyc = null;
  try { E.exportOrder([ent('A', { by: 'parent', through: 'B' }), ent('B', { by: 'parent', through: 'A' })]); }
  catch (e) { cyc = e.message; }
  check('  …and a cycle refuses rather than looping for ever', !!cyc && /A/.test(cyc) && /B/.test(cyc));

  /** AGAINST THE REAL MANIFEST, which is the only ordering that will ever run. */
  const real = Object.entries(M.TENANT_MANIFEST).map(([model, e]) => ({ model, reach: e.reach, take: e.take }));
  let realOrder = null; let realErr = null;
  try { realOrder = E.exportOrder(real); } catch (e) { realErr = e.message; }
  check('the REAL manifest produces a complete order with nothing unreachable',
    !!realOrder && realOrder.length === M.EXPORTED_MODELS.length, realErr ?? `${realOrder?.length} models in order`);
  check('  …with every parent-reachable model after the parent it is reached through',
    !!realOrder && M.BEYOND_A_GROUP_FILTER.filter((b) => b.reach.by === 'parent')
      .every((b) => realOrder.indexOf(b.model) > realOrder.indexOf(b.reach.through)),
    `${M.BEYOND_A_GROUP_FILTER.length} beyond a group filter`);

  console.log('\n— THE COLUMN THAT JOINS A CHILD TO ITS PARENT —');
  check('a model name becomes its id column', E.parentColumn('StagedInvoice') === 'staged_invoice_id'
    && E.parentColumn('Cost') === 'cost_id' && E.parentColumn('CatalogueItem') === 'catalogue_item_id',
    `${E.parentColumn('StagedInvoice')} · ${E.parentColumn('CatalogueItem')}`);
  /** CHECKED AGAINST THE DATABASE, not against the function that produced it. */
  prisma = await gatePrisma();
  const cols = async (t) => new Set((await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, t)).map((r) => r.column_name));
  const bad = [];
  for (const b of M.BEYOND_A_GROUP_FILTER) {
    if (b.reach.by !== 'parent') continue;
    if (!(await cols(b.model)).has(E.parentColumn(b.reach.through))) bad.push(`${b.model}.${E.parentColumn(b.reach.through)}`);
  }
  check('every column this ordering will actually query exists in the database', bad.length === 0, bad.join(', ') || 'all 15 present');

  console.log('\n— ID CHUNKING —');
  check('ids are chunked, so 50,000 invoices do not become one IN clause',
    E.chunk(Array.from({ length: 2500 }, (_, i) => i)).length === 3 && E.ID_CHUNK === 1000);
  check('  …and an empty list is no queries, not one empty query', E.chunk([]).length === 0);

  console.log('\n— A FILENAME CANNOT ESCAPE ITS FOLDER OR EAT ITS NEIGHBOUR —');
  check('path traversal is flattened', !E.safeSegment('../../etc/passwd').includes('/') && !E.safeSegment('../x').includes('..'),
    E.safeSegment('../../etc/passwd'));
  check('  …and an empty segment falls back rather than producing //', E.safeSegment('', 'no-registration') === 'no-registration');
  const taken = new Set();
  const a1 = E.photoPath({ registration: 'NU14KUF', takenAt: new Date('2026-08-18T10:00:00Z'), stage: 'during', slot: 'a', id: 'abcdef1234' }, taken);
  const a2 = E.photoPath({ registration: 'NU14KUF', takenAt: new Date('2026-08-18T10:00:00Z'), stage: 'during', slot: 'a', id: 'ffffff9999' }, taken);
  check('a photo is named for the car, the day and the stage', a1 === 'photos/NU14KUF/2026-08-18-during-a.jpg', a1);
  /** A ZIP WITH TWO IDENTICAL PATHS LOSES ONE AND REPORTS NOTHING. */
  check('  …and a second photo of the same thing gets its own name, not the first one’s', a2 !== a1 && a2.includes('ffffff99'), a2);
  const vid = E.photoPath({ registration: 'NU14KUF', takenAt: new Date('2026-08-18T10:00:00Z'), stage: 'after', slot: '', id: 'x1', mediaType: 'video' }, taken);
  check('  …a video is an mp4, because 85 of 157 on the live tenant are video', vid.endsWith('.mp4'), vid);
  const noReg = E.photoPath({ registration: null, takenAt: null, stage: null, slot: null, id: 'zz999999' }, taken);
  check('  …and a photo with nothing recorded still lands somewhere findable', noReg === 'photos/no-registration/undated-stage.jpg', noReg);

  console.log('\n— THE README IS PART OF THE PRODUCT —');
  const txt = E.readmeText({ garageName: 'Test Motors', generatedAt: new Date('2026-10-11T19:00:00Z'),
    rowTotal: 14461, fileCount: 60, blobCount: 157, omissions: M.OMITTED_MODELS.slice(0, 3) });
  check('it says an empty cell is a null and NOT zero', /It does not mean zero/.test(txt));
  check('it explains the apostrophe before somebody finds it and distrusts the file', /would otherwise be run as a formula/.test(txt));
  check('it says money is in pence, which is the single most misreadable thing in here', /4500 means 45.00 pounds/.test(txt));
  check('it says where to start, and that readable/ comes first', /Open these first/.test(txt));
  check('it lists what was deliberately left out, with the reason',
    M.OMITTED_MODELS.slice(0, 3).every((o) => txt.includes(o.model) && txt.includes(o.because.slice(0, 25))));
  check('  …and states that credentials are never exported', /never included in an export/.test(txt));
  check('the row and photo counts are the measured ones, not round numbers', /14,461 records/.test(txt) && /157 photos/.test(txt));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE WHOLE THING, ON A REAL TENANT, WITH A REAL ZIP
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— BUILT, AND OPENED AGAIN —');
  const { buildExport, exportKey } = await import(`${R}/lib/tenant-export-build.ts`);
  const { createWriteStream, mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { execFileSync } = await import('node:child_process');
  /**
   * THE ZIP IS OPENED BY A TOOL THAT IS NOT OURS, which is the point — but that makes `unzip` a
   * REQUIREMENT, not an assumption. Stated as a decline rather than left in a comment, so an
   * environment without it reports UNRUN with an unmet requirement instead of a red about the code.
   */
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); }
  catch { declineToRun('unzip is not on PATH, and the zip must be verified by a tool that is not ours'); }
  const os = await import('node:os');
  const path = await import('node:path');

  const sweepExp = async () => {
    const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: XP } }, select: { id: true } });
    const ids = vs.map((v) => v.id);
    const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
    const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
    await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } });
    await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
    await prisma.jobCardPhoto.deleteMany({ where: { job_card_id: { in: cards } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: XP } } });
    return ids.length;
  };
  await sweepExp();

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${XP} Buyer`, address: '1 Road' }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${XP}01`, registration_normalized: `${XP}01`, make: 'MINI', model: 'Cooper' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'invoiced' }, select: { id: true } });
  /**
   * A VALUE THAT WOULD RUN AS A FORMULA, carried end to end into the file a garage opens.
   * It goes in the ADDRESS, not the name: Excel only executes a cell that STARTS with `=`, and the
   * name has to keep the sweep prefix or teardown cannot find this row. The first version of this
   * fixture put it in the name after the prefix, where it was correctly left alone — the clause was
   * asserting against a value that was never dangerous.
   */
  const nasty = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${XP} Formula`, address: '=HYPERLINK("http://x","click")' }, select: { id: true } });
  /**
   * AN INVOICE WITH A LINE, so the isolation clause below has a POPULATION. Without it
   * InvoiceLine.csv is empty, "no foreign rows" is true of nothing, and the most important clause
   * in this gate passes while proving that a parent traversal was never exercised at all.
   */
  const seq = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { last_value: true } });
  const inv = await prisma.invoice.create({
    data: { group_id: ZZ_GROUP, site_id: site.id, job_card_id: card.id, series: 'chargeable',
      sequence_value: (seq?.last_value ?? 0) + 900000, invoice_number: `${XP}-900000`,
      status: 'issued', date_issued: new Date('2026-10-01T00:00:00Z'), vat_position: 'standard',
      // Freeze-at-issue: these are required with no default, by design.
      company_name_snapshot: 'ZZ Gate Garage', customer_name_snapshot: `${XP} Buyer`, vat_registered_at_issue: true },
    select: { id: true },
  });
  await prisma.invoiceLine.create({
    data: { invoice_id: inv.id, description: 'Gate fixture line', qty: 1, unit_price: 100,
      vat_rate: 20, line_vat: 20, line_total: 100, position: 1 },
  });
  const photo = await prisma.jobCardPhoto.create({
    data: { group_id: ZZ_GROUP, job_card_id: card.id, stage: 'during', slot: 'a', r2_key: `${ZZ_GROUP}/zzexp/one.jpg`, media_type: 'photo' },
    select: { id: true, r2_key: true },
  });
  const gone = await prisma.jobCardPhoto.create({
    data: { group_id: ZZ_GROUP, job_card_id: card.id, stage: 'after', slot: 'b', r2_key: `${ZZ_GROUP}/zzexp/missing.jpg`, media_type: 'video' },
    select: { id: true, r2_key: true },
  });

  const BYTES = Buffer.from('fake-image-bytes-0123456789');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zzexp-'));
  const zipPath = path.join(dir, 'export.zip');
  /** INJECTED. R2 credentials do not exist outside production, so the seam is the only way this
   *  clause can run at all — and it still proves the naming, the index and the missing-blob count. */
  const fetchBlob = async (key) => (key === gone.r2_key ? null : Readable.from([BYTES]));
  const res = await buildExport(ZZ_GROUP, { prisma, out: createWriteStream(zipPath), fetchBlob, now: () => new Date('2026-10-11T20:00:00Z') });

  check('the export builds and the file exists', existsSync(zipPath) && res.rowTotal > 0, `${res.rowTotal} rows, ${res.fileCount} files`);
  let zipOk = true; let zipErr = '';
  try { execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' }); } catch (e) { zipOk = false; zipErr = String(e.stderr || e).slice(0, 80); }
  /** OPENED BY A TOOL THAT IS NOT OURS. A zip we wrote and only we can read is not a deliverable. */
  check('  …and unzip opens it without complaint', zipOk, zipErr || 'archive intact');
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
  // TOLERANT ON PURPOSE. `unzip -p` on an absent entry THROWS, which ends the gate and leaves every
  // later clause unrun — so a mutation that drops one file would be scored as one red plus silence,
  // and the silence is the part that misleads (the-tally-is-not-the-coverage).
  const read = (p) => { try { return execFileSync('unzip', ['-p', zipPath, p], { encoding: 'utf8' }); } catch { return ''; } };

  check(`one CSV per exported model (${M.EXPORTED_MODELS.length} expected)`,
    M.EXPORTED_MODELS.every((m) => listing.includes(`tables/${m}.csv`)),
    M.EXPORTED_MODELS.filter((m) => !listing.includes(`tables/${m}.csv`)).join(', ') || 'all present');
  check('  …and NOT one for anything the manifest omits',
    M.OMITTED_MODELS.every((o) => !listing.includes(`tables/${o.model}.csv`)),
    M.OMITTED_MODELS.filter((o) => listing.includes(`tables/${o.model}.csv`)).map((o) => o.model).join(', ') || 'no omitted model leaked in');
  check('the readable views are there, which is the folder a garage actually opens',
    ['readable/invoices.csv', 'readable/job-cards.csv', 'readable/vehicles.csv'].every((f) => listing.includes(f)));
  check('  …along with the README and the manifest',
    listing.includes('READ-ME-FIRST.txt') && listing.includes('manifest.json'));
  check('no entry is an absolute path or escapes the folder',
    listing.every((f) => !f.startsWith('/') && !f.includes('..')), listing.filter((f) => f.startsWith('/') || f.includes('..')).join(', ') || 'all relative');

  /**
   * THE CLAUSE THAT MATTERS MOST. A parent-reachable model is queried by its parent's ids, so a
   * traversal bug does not produce an error — it produces another tenant's rows in this garage's
   * file. Asserted against the database's own answer for who owns those invoices.
   */
  const zzInvoiceIds = new Set((await prisma.invoice.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((r) => r.id));
  const lineCsv = read('tables/InvoiceLine.csv');
  const lineRows = lineCsv.trim().split('\r\n').slice(1).filter(Boolean);
  const invIdCol = lineCsv.split('\r\n')[0].replace('\uFEFF', '').split(',').indexOf('invoice_id');
  const foreign = lineRows.map((r) => r.split(',')[invIdCol]).filter((id) => id && !zzInvoiceIds.has(id));
  // `lineRows.length > 0` is carried ON PURPOSE: "no foreign rows" is true of an empty file, so
  // without it this clause passes when the parent traversal returned nothing at all.
  check(`a parent-reachable model carries ONLY this tenant's rows (${lineRows.length} invoice lines)`,
    invIdCol >= 0 && lineRows.length > 0 && foreign.length === 0,
    foreign.length ? `${foreign.length} line(s) belong to another tenant` : `${lineRows.length} line(s), every one on a ZZ invoice`);

  /**
   * THE MONEY IN THE READABLE VIEW. One fixture invoice, one line: ex-VAT 100, VAT 20. The first
   * version computed net as line_total MINUS line_vat, but line_total is already ex-VAT, so every
   * net figure in the file a garage sends its accountant was understated by the VAT.
   */
  const invCsv = read('readable/invoices.csv');
  const invLine = invCsv.split('\r\n').find((l) => l.includes(`${XP}-900000`)) ?? '';
  check('the readable invoice carries net, VAT and gross that add up',
    invLine.includes(',100.00,20.00,120.00,'), invLine.slice(-60) || 'ROW NOT FOUND');
  check('  …and names the customer and the car rather than their ids',
    invLine.includes(`${XP} Buyer`) && invLine.includes(`${XP}01`), invLine.slice(0, 80));

  console.log('\n— THE BYTES, AND THE ONES THAT ARE NOT THERE —');
  const photoEntry = listing.find((f) => f.startsWith(`photos/${XP}01/`));
  check('a photo is in the zip, under its registration', !!photoEntry, photoEntry ?? 'NO PHOTO ENTRY');
  check('  …and its contents are the bytes, not a placeholder',
    !!photoEntry && read(photoEntry) === BYTES.toString(), `${photoEntry ? read(photoEntry).length : 0} bytes`);
  const idx = read('photos/index.csv');
  check('  …the index says which job card it belongs to', idx.includes(card.id));
  /** A MISSING OBJECT IS COUNTED AND NAMED. Silently dropping it is how a garage finds out years
   *  later that the photo it needed was never in the file. */
  check('a photo whose object is gone is COUNTED, not silently dropped',
    res.blobMissing === 1 && res.blobCount === 1, `${res.blobCount} copied, ${res.blobMissing} missing`);
  check('  …and the index says so in words, against that row',
    /no — the file could not be read from storage/.test(idx), idx.split('\r\n').find((l) => l.includes('missing.jpg'))?.slice(0, 80));

  console.log('\n— WHAT MUST NOT BE IN IT —');
  const userCsv = read('tables/User.csv');
  check('the password hash column is not even a header', !/passwordHash/.test(userCsv));
  check('  …nor the invite or reset token hashes', !/invite_token_hash|reset_token_hash/.test(userCsv));
  const custCsv = read('tables/Customer.csv');
  const nastyLine = custCsv.split('\r\n').find((l) => l.includes('HYPERLINK')) ?? '';
  check('a customer field that would run as a formula is neutralised in the file itself',
    nastyLine.includes(`'=HYPERLINK`), nastyLine.slice(-70) || 'ROW NOT FOUND');
  check('  …and the apostrophe is the only change — the formula text survives intact',
    nastyLine.includes('HYPERLINK(""http://x"",""click"")'), nastyLine.slice(-60));
  const readme = read('READ-ME-FIRST.txt');
  check('the README names this tenant and lists the omissions', readme.includes('WHAT IS NOT IN HERE') && /records across/.test(readme));
  const man = JSON.parse(read('manifest.json'));
  check('the manifest records the counts the job will store', man.rowTotal === res.rowTotal && man.blobMissing === 1, `${man.rowTotal} rows`);
  check('the object key lands inside the tenant’s own partition',
    exportKey(ZZ_GROUP, 'abcdef1234', new Date('2026-10-11T00:00:00Z')).startsWith(`${ZZ_GROUP}/exports/`),
    exportKey(ZZ_GROUP, 'abcdef1234', new Date('2026-10-11T00:00:00Z')));

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: XP } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
      const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
      await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } });
      await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
      await prisma.jobCardPhoto.deleteMany({ where: { job_card_id: { in: cards } } });
      await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: XP } } });
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: XP } } })
        + await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: XP } } });
      check('teardown left none of this gate’s rows', left === 0, `${left} left`);
    } catch (e) { check('teardown ran', false, describeError(e).slice(0, 120)); }
  }
  await prisma?.$disconnect?.().catch(() => {});
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
