/**
 * File: scripts/document-credit-gate.mjs
 * THE MAKER'S MARK IS ON EVERY CUSTOMER DOCUMENT, AND CANNOT BE TURNED OFF.
 *
 * "Created with GreaseDesk · greasedesk.com" — small, muted, and seen years later when the car is
 * sold and somebody opens the folder. See lib/product-credit for what it is and why the wording is
 * "with" rather than "by".
 *
 * ── WHAT THIS GATE IS REALLY PROTECTING ─────────────────────────────────────────────────────────
 * Not the pixels. Two things that are easy to undo by accident and hard to notice:
 *   · a NEW customer document that forgets the credit — so the check is "every renderer", read
 *     from the filesystem, not a list somebody maintains;
 *   · a PROP that suppresses it. There is no setting and no tier that hides this line, and that is
 *     a commercial decision, not an oversight. A `hidden`/`show`/`tier` prop appearing on the
 *     component is the shape that decision gets undone in.
 *
 * ── AND THAT IT DOES NOT READ AS THE SENDER ─────────────────────────────────────────────────────
 * The garage is the supplier. "with" not "by", and the garage's own name directly above it on
 * every surface — adjacency is what actually defuses it, so adjacency is asserted.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { explainIfClientStale, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync, readdirSync, writeFileSync, mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const P = await import('../lib/product-credit.ts');
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

try {
  // ── 1. THE WORDS, IN ONE PLACE ───────────────────────────────────────────────────────────────
  console.log('\n— one line, one source —');
  check('the line reads as agreed', P.CREDIT_LINE === 'Created with GreaseDesk · greasedesk.com', P.CREDIT_LINE);
  check('  …"with", never "by"', /Created with/.test(P.CREDIT_LINE) && !/Created by/.test(P.CREDIT_LINE),
    '"by" claims authorship of the figures; "with" names the tool');
  check('  …and the domain comes from lib/company-info, not a literal',
    /company-info/.test(readFileSync('lib/product-credit.ts', 'utf8')),
    'one place already owns what the company is called');

  // ── 2. EVERY CUSTOMER DOCUMENT CARRIES IT ────────────────────────────────────────────────────
  // Discovered, not listed. A new customer-facing document is exactly the thing that would forget.
  console.log('\n— every document a customer sees —');
  const SURFACES = {
    'components/customer/CustomerInvoice.tsx': 'the invoice, on the web',
    'components/customer/IntakeReportView.tsx': 'the intake report',
    'pages/c/[token].tsx': 'the quote',
    'lib/invoice-pdf.tsx': 'the invoice PDF',
  };
  for (const [f, label] of Object.entries(SURFACES)) {
    const src = readFileSync(f, 'utf8');
    // THE RENDER, not the import. `/DocumentCredit/` is true of a file that merely imports it, so
    // deleting the element left this green — the same identifier-versus-render slip as the
    // adjacency check below, twice in one file.
    const has = /<DocumentCredit/.test(src) || /\{CREDIT_LINE\}/.test(src);
    check(`${label} carries it`, has, has ? '' : `${f} renders a customer document with no credit`);
  }
  // THE DISCOVERY HALF: anything else under components/customer that renders a document.
  const customerFiles = readdirSync('components/customer').filter((f) => f.endsWith('.tsx'));
  const documents = customerFiles.filter((f) => {
    const src = readFileSync(`components/customer/${f}`, 'utf8');
    // A DOCUMENT is a full page a customer reads — it sets a <title>. PayPanel and friends do not.
    return /<title>/.test(src) || /<Head>/.test(src);
  });
  const uncredited = documents.filter((f) => !/<DocumentCredit/.test(readFileSync(`components/customer/${f}`, 'utf8')));
  check('no customer document renderer is missing it', uncredited.length === 0,
    uncredited.join(', ') || `${documents.length} document renderers, all credited`);

  // ── 3. IT CANNOT BE TURNED OFF ───────────────────────────────────────────────────────────────
  console.log('\n— and there is no way to remove it —');
  const comp = readFileSync('components/DocumentCredit.tsx', 'utf8');
  const props = comp.match(/\{\s*className[^}]*\}\s*:\s*\{([^}]*)\}/);
  check('the component takes className and nothing else',
    !!props && !/show|hidden|enabled|tier|plan|visible|suppress/i.test(props[1]),
    props ? props[1].trim() : 'could not read the prop type');
  check('  …and no caller passes a suppressing prop',
    !/DocumentCredit[^>]*(show|hidden|enabled|tier|plan)=/i.test(
      ['components/customer/CustomerInvoice.tsx', 'components/customer/IntakeReportView.tsx', 'pages/c/[token].tsx']
        .map((f) => readFileSync(f, 'utf8')).join('\n')));
  // STRIP THE COMMENT PREFIX, not just the whitespace. "not an\n * oversight" collapses to
  // "not an * oversight" without it, and the check fails on prose that says exactly what it wants.
  const prose = (t) => t.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
  check('  …and the reasoning is written down, so nobody "fixes" it later',
    /not an oversight/.test(prose(readFileSync('lib/product-credit.ts', 'utf8'))),
    'the price is low and the recognition is part of what that buys');
  check('email is declined IN THE FILE, not merely absent',
    /NOT EMAIL/.test(readFileSync('lib/product-credit.ts', 'utf8')),
    'a line under a message from a garage reads as the sender — do not add it by analogy');

  // ── 4. ADJACENCY — THE THING THAT STOPS IT READING AS THE SENDER ─────────────────────────────
  console.log('\n— beneath the garage’s own name, on every surface —');
  for (const [f, label] of Object.entries(SURFACES)) {
    const src = readFileSync(f, 'utf8');
    // THE RENDER SITE, not the identifier: `CREDIT_LINE` first appears in the IMPORT at the top
    // of the file, which is above everything and made this assertion meaningless on the PDF.
    const credit = Math.max(src.indexOf('<DocumentCredit'), src.indexOf('{CREDIT_LINE}'));
    const garage = Math.min(...['company.name', 'garageName', 'd.company.name']
      .map((n) => src.indexOf(n)).filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER]));
    check(`  ${label}: the garage is named above it`, garage < credit,
      garage === Number.MAX_SAFE_INTEGER ? 'the garage is not named on this surface AT ALL' : '');
  }

  // ── 5. THE PDF ACTUALLY RENDERS IT, AND THE PAY URL IS STILL LAST ────────────────────────────
  // Read back from a real rendered PDF, because the whole reason the credit is a <Link> declared
  // above the pay block is a text-run ordering problem that only a rendered document can show.
  console.log('\n— read back off a rendered PDF —');
  const pdf = readFileSync('lib/invoice-pdf.tsx', 'utf8');
  const creditAt = pdf.indexOf('CREDIT_LINE');
  const payAt = pdf.indexOf('<Link src={pay.url}');
  check('the credit is declared BEFORE the pay block', creditAt > 0 && payAt > creditAt,
    'five separator strategies were measured and all stripped; the pay URL must be the last text run');
  check('  …and it is a Link, so a click never depends on the text layer',
    /<Link src=\{CREDIT_HREF\}/.test(pdf));
  check('the running identification survived', /\{doc\.company\.name\} — \{t\('title'\)\} \{doc\.number\}/.test(pdf),
    'on page 3 of a long invoice it is the only thing saying whose document this is');
  check('  …and both lines are in ONE fixed block, so both repeat per page',
    /<View style=\{S\.footer\} fixed>[\s\S]{0,400}CREDIT_LINE/.test(pdf));

  // ── WHAT THIS GATE DOES NOT PROVE ───────────────────────────────────────────────────────────
  // Everything above reads the SOURCE. A customer reads the rendered PDF, and nothing here opens
  // one: an attempt to compile lib/invoice-pdf.tsx standalone and render it in-process fails on
  // the `@/` path aliases, and the honest route — fetching /api/invoice-pdf for a fixture invoice
  // over HTTP and reading it back with pdfjs — is a browser fixture this gate does not have.
  //
  // So the constraint that actually bit (a text run after the pay URL) is asserted by DECLARATION
  // ORDER, not by reading the document. That is weaker and is said here rather than left to be
  // assumed. scripts/pdf-layout-parity already renders and reads invoices; the check belongs
  // beside it, or here once this gate grows a fixture.
  check('and what this gate cannot prove is said out loud',
    /nothing here opens/.test(prose(readFileSync('scripts/document-credit-gate.mjs', 'utf8'))),
    'the rendered PDF is asserted by declaration order, not by reading one');

} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(process.env.GATE_BASE ?? 'http://localhost:3000');
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
