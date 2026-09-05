/**
 * File: scripts/tax-display-gate.mjs
 * "VAT REGISTRATION: NOT REGISTERED" BESIDE "TAX MODEL: VAT" IS NOT A CONTRADICTION, AND THE
 * ENGINE ROOM HAS TO STOP PRINTING IT AS IF IT WERE.
 * @gate-requires: db
 *
 * ── WHAT THE TWO FACTS ARE ──────────────────────────────────────────────────────────────────────
 * `tax_model` is the REGIME the tenant's country runs, written once at the country step from
 * lib/locale-profiles and never touched again. `vat_registered` is that tenant's STATUS within it.
 * A sub-threshold UK garage is genuinely "VAT regime, not registered" — the commonest state a small
 * garage is in, and the reason taxOnBasePennies returns 0 for them. Orthogonal facts, rendered on
 * two adjacent lines as if one denied the other.
 *
 * ── AND IT IS WORSE OUTSIDE THE UK ──────────────────────────────────────────────────────────────
 * The registration row's label was the literal string "VAT registration" for every tenant. The one
 * non-GB tenant in the database, US-GD2175, runs `sales_tax` with no VAT number and read:
 *
 *     VAT registration    Registered          <- a US garage, registered for a tax its country has
 *     VAT number          —                      no concept of, with no number to show for it
 *     Tax model           sales_tax           <- the raw enum, straight out of the column
 *
 * ── WHAT THIS HOLDS ─────────────────────────────────────────────────────────────────────────────
 * Both rows are built by ONE shaper from the tenant's own tax_label and country, and the
 * unregistered case states its CONSEQUENCE rather than its status: "Not registered" makes an
 * operator ask a follow-up question, and answering it is the only reason the row is on the screen.
 *
 * ── WHAT IT DOES NOT DO, STATED HERE ────────────────────────────────────────────────────────────
 * It does not drive the Engine Room in a browser. That portal needs an operator session behind
 * TOTP, no gate has ever driven it, and standing one up for two label rows is a poor trade. So the
 * page is held STRUCTURALLY — it must render through the shaper and must no longer contain the
 * hardcoded label or the raw enum — and the strings themselves are proven against the shaper fed
 * with the REAL stored columns of both live shapes, read-only. What that leaves unproven is the
 * wiring between the two, and this sentence is where a reader learns it.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
// Tolerant: absent before this slice lands, so the run reaches every check instead of dying at 1.
const T = await import('../lib/tax.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const ER_PAGE = 'pages/superadmin/tenants/[id].tsx';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
/** Comments stripped: a rule named in prose is not a rule applied in code. */
const prose = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const show = (a) => { try { return T.taxDisplay(a); } catch { return null; } };

try {
  // ── 1. THE SHAPER ────────────────────────────────────────────────────────────────────────────
  console.log('\n— two facts, said as two facts —');
  check('lib/tax exports one shaper for both rows', typeof T.taxDisplay === 'function',
    `taxDisplay=${typeof T.taxDisplay}`);

  const gbYes = show({ taxLabel: 'VAT', countryCode: 'GB', isRegistered: true });
  check('the regime names the tax AND the country', gbYes?.regimeValue === 'VAT (United Kingdom)',
    String(gbYes?.regimeValue));
  // PAIRED WITH A POSITIVE. "does not contain the enum" is true of undefined and of a blank string,
  // so on its own it passes hardest against a shaper that does not exist.
  check('  …not the raw enum',
    typeof gbYes?.regimeValue === 'string' && gbYes.regimeValue.length > 0 && !/vat|sales_tax/.test(gbYes.regimeValue),
    'the column holds `vat`; an operator should never be shown the column');
  check('the registration row is labelled with the tenant’s own word',
    gbYes?.registrationLabel === 'Registered for VAT', String(gbYes?.registrationLabel));
  check('  …and a registered tenant just says yes', gbYes?.registrationValue === 'Yes',
    String(gbYes?.registrationValue));

  const gbNo = show({ taxLabel: 'VAT', countryCode: 'GB', isRegistered: false });
  // THE ROW THAT EXISTS TO ANSWER A QUESTION, ANSWERING IT.
  check('an unregistered tenant states the CONSEQUENCE',
    gbNo?.registrationValue === 'No — no VAT is charged on any document',
    String(gbNo?.registrationValue));
  check('  …while the regime is unchanged by it', gbNo?.regimeValue === 'VAT (United Kingdom)',
    'the country still runs VAT; this tenant is simply not in it — that is the whole point');

  const usYes = show({ taxLabel: 'Sales Tax', countryCode: 'US', isRegistered: true });
  check('a US tenant is not asked about VAT', usYes?.registrationLabel === 'Registered for Sales Tax',
    String(usYes?.registrationLabel));
  check('  …and its regime names its own country', usYes?.regimeValue === 'Sales Tax (United States)',
    String(usYes?.regimeValue));
  const usNo = show({ taxLabel: 'Sales Tax', countryCode: 'US', isRegistered: false });
  check('  …and its consequence is in its own words',
    usNo?.registrationValue === 'No — no Sales Tax is charged on any document',
    String(usNo?.registrationValue));

  // HONEST-NULL: a tenant that has not reached the country step has no country to name, and the
  // shaper must not borrow the default one. getProfile falls back to GB, which is right for
  // BEHAVIOUR and wrong for a label that would then assert a country nobody chose.
  const noCountry = show({ taxLabel: 'VAT', countryCode: null, isRegistered: false });
  check('a tenant with no country yet is not given one', noCountry?.regimeValue === 'VAT',
    `${noCountry?.regimeValue} — getProfile defaults to GB for behaviour; a LABEL must not`);

  // ── 2. THE PAGE RENDERS THROUGH IT ───────────────────────────────────────────────────────────
  console.log('\n— and the page says it that way —');
  const page = prose(readFileSync(ER_PAGE, 'utf8'));
  check('the Engine Room reads the shaper', /taxDisplay\(/.test(page),
    'two rows built in the page are two chances to disagree with the tax chokepoint');
  // THE HARDCODED LABEL, matched as the STRING IT WAS rather than as a word prose could contain.
  check('  …and no longer hardcodes "VAT registration"', !/"VAT registration"|>VAT registration</.test(page),
    'it was that literal for every tenant, including the ones with no VAT');
  check('  …nor prints the raw model column', !/\{b\.taxModel\}/.test(page),
    'the enum is a storage detail; `sales_tax` is not a sentence');
  check('  …and it selects the label it now renders', /tax_label:\s*true/.test(page),
    'the page read tax_model and never tax_label, which is why it had nothing better to print');

  // ── 3. THE HEADER SAYS WHAT THE CODE DOES ────────────────────────────────────────────────────
  // lib/tax's header said sales_tax THROWS. FLAT_RATE_MODELS has contained it for some time, so a
  // US tenant computes a flat rate like any VAT one. A file documenting a rule it does not enforce
  // is worse than one documenting nothing: the next reader plans around the sentence.
  console.log('\n— and the file describes the rule it enforces —');
  const taxSrc = readFileSync('lib/tax.ts', 'utf8');
  const flat = /const FLAT_RATE_MODELS = new Set<TaxModel>\(\[([^\]]*)\]\)/.exec(taxSrc)?.[1] ?? '';
  const flatHasSalesTax = /'sales_tax'/.test(flat);
  check('sales_tax is a flat-rate model in the code', flatHasSalesTax, `FLAT_RATE_MODELS = [${flat.trim()}]`);
  const header = taxSrc.slice(0, taxSrc.indexOf('*/'));
  check('  …and the header does not claim it throws',
    !/sales_tax\s*\/\s*gst_split are real values\s*\n?\s*\*?\s*that THROW/.test(header)
    && !/only 'vat' is implemented/i.test(header),
    'the header outranks the code for anybody reading before writing');
  check('  …and names what actually throws', /gst_split/.test(header) && /THROW/.test(header),
    'one model still does, and a header that mentions neither is no better');

  // ── 4. AGAINST THE REAL COLUMNS OF BOTH LIVE SHAPES ──────────────────────────────────────────
  // Read-only. The strings above are proven against inputs this gate invented; these are the two
  // shapes that actually exist, so a column that does not hold what the shaper expects is caught
  // here rather than by an operator.
  console.log('\n— against the tenants that exist —');
  const zz = await prisma.group.findUnique({ where: { id: ZZ },
    select: { tax_label: true, country_code: true, vat_registered: true, tax_model: true } });
  const zzShown = show({ taxLabel: zz?.tax_label, countryCode: zz?.country_code, isRegistered: !!zz?.vat_registered });
  check('ZZ Gate Garage reads as a UK tenant', zzShown?.regimeValue === 'VAT (United Kingdom)',
    `${zzShown?.regimeValue} | ${zzShown?.registrationLabel}: ${zzShown?.registrationValue}`);

  const us = await prisma.group.findFirst({ where: { tax_model: { not: 'vat' } },
    select: { ref: true, tax_label: true, country_code: true, vat_registered: true, tax_model: true } });
  check('there is a non-VAT tenant to check against', !!us,
    us ? `${us.ref} (${us.tax_model})` : 'NONE — every assertion below is about nothing');
  const usShown = show({ taxLabel: us?.tax_label, countryCode: us?.country_code, isRegistered: !!us?.vat_registered });
  check('  …and it is no longer asked about VAT',
    usShown?.registrationLabel === 'Registered for Sales Tax' && usShown?.regimeValue === 'Sales Tax (United States)',
    `${usShown?.regimeValue} | ${usShown?.registrationLabel}: ${usShown?.registrationValue}`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
