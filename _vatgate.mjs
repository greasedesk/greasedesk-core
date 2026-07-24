// VAT-residue slice GATE — all discriminating proofs against a fully-onboarded sales_tax (US) tenant.
// Deploy under test: buildId sxWw089nEb7XtprE7uIxt (commit fe30f74).
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = 'https://greasedesk.com';
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const p = new PrismaClient();
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// ---- cookie-jar fetch ----
function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    async fetch(url, opts = {}) {
      const res = await fetch(url, { ...opts, redirect: 'manual', headers: { ...(opts.headers || {}), cookie: this.header() } });
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
      return res;
    },
  };
}
async function login(jar, email, password) {
  const csrfRes = await jar.fetch(`${HOST}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();
  const body = new URLSearchParams({ csrfToken, email, password, json: 'true', callbackUrl: `${HOST}/admin/dashboard` });
  await jar.fetch(`${HOST}/api/auth/callback/credentials`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const sess = await (await jar.fetch(`${HOST}/api/auth/session`)).json();
  return sess?.user?.id ? sess : null;
}
// strip React <!-- --> text-boundary markers, then <script>/<style>, then tags → visible text
const stripComments = (h) => h.replace(/<!--\s*-->/g, '');
const visibleText = (h) => stripComments(h)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const countWordVAT = (s) => (s.match(/\bVAT\b/g) || []).length; // case-sensitive whole word

let fx = null; // fixture ids for teardown
let tmbsUser = null;

try {
  // =========================================================================
  // PHASE A — build a FULLY-ONBOARDED sales_tax (US) fixture with one issued invoice
  // =========================================================================
  const stamp = Date.now();
  const pw = 'GateP@ss!' + stamp;
  const hash = await bcrypt.hash(pw, 10);

  const grp = await p.group.create({ data: {
    group_name: `ZZ Gate US ${stamp}`, billing_email: `zz-gate-us-${stamp}@example.com`,
    country_code: 'US', tax_country_code: 'US', tax_model: 'sales_tax', tax_label: 'Sales Tax',
    tax_default_rate_bp: 850, default_vat_rate: 8.5, vat_registered: true, vat_number: null,
    fy_start_month: 1,
  }});
  const site = await p.site.create({ data: {
    group_id: grp.id, site_name: 'Main Shop', currency_code: 'USD', locale: 'en-US', timezone: 'America/New_York',
  }});
  await p.serviceCatalogue.create({ data: {
    group_id: grp.id, service_code: 'LABOUR_HR', name: 'Labour', default_labour_rate: 120, vat_rate: 8.5,
  }});
  await p.groupBilling.create({ data: {
    group_id: grp.id, plan_name: 'Trial', status: 'ok', retention_months: 12, included_sites: 1,
    subscription_status: 'trialing',
  }});
  const admin = await p.user.create({ data: {
    email: `zz-gate-admin-${stamp}@example.com`, name: 'Gate Admin', passwordHash: hash, role: 'ADMIN',
    is_owner: true, is_active: true, group_id: grp.id, site_id: site.id, primary_site_id: site.id,
  }});
  const cust = await p.customer.create({ data: { group_id: grp.id, site_id: site.id, name: 'Jane Roadside', address: '5 Main St, Springfield' }});
  const veh = await p.vehicle.create({ data: { group_id: grp.id, registration: 'US-GATE-1', make: 'Ford', model: 'F-150', mileage_at_create: 40000 }});
  const card = await p.jobCard.create({ data: {
    group_id: grp.id, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'invoiced', odometer_in: 40000, vat_rate: 8.5,
  }});
  const issued = new Date('2026-07-15T10:00:00.000Z');
  const inv = await p.invoice.create({ data: {
    group_id: grp.id, job_card_id: card.id, site_id: site.id, status: 'issued', series: 'chargeable',
    sequence_value: 1, invoice_number: 'US-0001', issued_at: issued, date_issued: issued,
    company_name_snapshot: grp.group_name, company_vat_number_snapshot: null, company_address_snapshot: null,
    customer_name_snapshot: cust.name, customer_address_snapshot: cust.address,
    vehicle_reg_snapshot: veh.registration, vehicle_desc_snapshot: 'Ford F-150', vat_registered_at_issue: true,
  }});
  await p.invoiceLine.create({ data: {
    invoice_id: inv.id, description: 'Brake pads (front)', qty: 2, unit_price: 100, vat_rate: 8.5,
    line_vat: 17.0, line_total: 200.0, position: 0,
  }});
  await p.invoiceSequence.create({ data: { group_id: grp.id, last_value: 1 }});
  fx = { grpId: grp.id, adminId: admin.id, invId: inv.id };
  console.log(`\n[fixture] US group ${grp.id} — invoice ${inv.id} — admin ${admin.email}\n`);

  // =========================================================================
  // PHASE B — log in as the US admin
  // =========================================================================
  const jar = makeJar();
  const sess = await login(jar, admin.email, pw);
  if (!sess) throw new Error('US admin login failed — cannot run gate');
  console.log(`[auth] logged in as US admin (group ${sess.user.group_id})\n`);

  const range = 'from=2026-07-01&to=2026-07-31';
  const tmp = mkdtempSync(join(tmpdir(), 'vatgate-'));

  // ---- PROOF 1: VAT-summary PDF → bytes → pdftotext → text ----
  {
    const r = await jar.fetch(`${HOST}/api/reports/vat-summary-pdf?${range}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const isPdf = buf.slice(0, 4).toString() === '%PDF';
    const f = join(tmp, 'summary.pdf'); writeFileSync(f, buf);
    let text = '';
    try { text = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' }); } catch (e) { text = ''; }
    const hasLabel = /Sales Tax/.test(text);
    const vatN = countWordVAT(text);
    rec('P1 VAT-summary PDF: is a PDF', isPdf && r.status === 200, `status ${r.status}, ${buf.length}B`);
    rec('P1 VAT-summary PDF: text contains "Sales Tax"', hasLabel, `label ${hasLabel}`);
    rec('P1 VAT-summary PDF: ZERO literal "VAT" (PRIMARY missing proof)', vatN === 0, `VAT count=${vatN}`);
  }

  // ---- PROOF 2: report page HTML → rendered ----
  {
    const r = await jar.fetch(`${HOST}/admin/reports/vat?${range}`);
    const html = await r.text();
    const redirected = r.status >= 300 && r.status < 400;
    const txt = visibleText(html);
    const hasLabel = /Sales Tax on sales/.test(txt);
    const vatN = countWordVAT(txt);
    rec('P2 report page: 200 (not onboarding-redirected)', r.status === 200 && !redirected, `status ${r.status}`);
    rec('P2 report page: visible text contains "Sales Tax on sales"', hasLabel, '');
    rec('P2 report page: ZERO literal "VAT" in visible text', vatN === 0, `VAT count=${vatN}`);
  }

  // ---- PROOF 3: settings/Company Profile details page ----
  {
    const r = await jar.fetch(`${HOST}/admin/settings/company/details`);
    const html = await r.text();
    const txt = visibleText(html);
    const label = /Registered for Sales Tax/.test(txt);
    const rate = /Default Sales Tax rate/.test(txt);
    const noNumberField = !/Sales Tax number/.test(txt) && !/VAT number/.test(txt);
    const vatN = countWordVAT(txt);
    rec('P3 settings details: 200 (not onboarding-redirected)', r.status === 200, `status ${r.status}`);
    rec('P3 settings details: "Registered for Sales Tax"', label, '');
    rec('P3 settings details: "Default Sales Tax rate"', rate, '');
    rec('P3 settings details: NO tax-number field (suppressed for sales_tax)', noNumberField, '');
    rec('P3 settings details: ZERO literal "VAT" in visible text', vatN === 0, `VAT count=${vatN}`);
  }

  // ---- PROOF 3b (positive control, SAME fixture): flip to VAT → tax-number field returns ----
  {
    await p.group.update({ where: { id: grp.id }, data: { tax_model: 'vat', tax_label: 'VAT' } });
    const r = await jar.fetch(`${HOST}/admin/settings/company/details`);
    const txt = visibleText(await r.text());
    const fieldBack = /VAT number/.test(txt);
    const labelBack = /Registered for VAT/.test(txt);
    rec('P3b positive control (flip→vat): "VAT number" field RETURNS', fieldBack, 'proves suppression is tax_model-driven, not a global removal');
    rec('P3b positive control (flip→vat): "Registered for VAT"', labelBack, '');
    // restore US identity for the remaining US re-assertions
    await p.group.update({ where: { id: grp.id }, data: { tax_model: 'sales_tax', tax_label: 'Sales Tax' } });
  }

  // ---- RE-ASSERT green ones (regression guards; code untouched this slice) ----
  {
    const r = await jar.fetch(`${HOST}/admin/invoices/${inv.id}`);
    const txt = visibleText(await r.text());
    rec('G4 US invoice VIEW: contains "Sales Tax"', r.status === 200 && /Sales Tax/.test(txt), `status ${r.status}`);
  }
  {
    const r = await jar.fetch(`${HOST}/api/invoice-pdf?id=${inv.id}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const f = join(tmp, 'inv.pdf'); writeFileSync(f, buf);
    let text = ''; try { text = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' }); } catch {}
    const ok = r.status === 200 && buf.slice(0, 4).toString() === '%PDF';
    rec('G5 US invoice PDF: 200 + "Sales Tax" + zero VAT', ok && /Sales Tax/.test(text) && countWordVAT(text) === 0, `status ${r.status}, VAT=${countWordVAT(text)}`);
  }
  {
    const r = await jar.fetch(`${HOST}/api/reports/vat-summary?${range}&format=csv`);
    const csv = await r.text();
    rec('G6 CSV: "Total output Sales Tax" + zero literal VAT', r.status === 200 && /Total output Sales Tax/.test(csv) && countWordVAT(csv) === 0, `VAT=${countWordVAT(csv)}`);
  }
  {
    const r = await jar.fetch(`${HOST}/admin/invoices`);
    const txt = visibleText(await r.text());
    rec('G7 invoices-list link: "Sales Tax on sales"', r.status === 200 && /Sales Tax on sales/.test(txt), '');
  }

  // =========================================================================
  // PHASE C — TMBS regression (REGRESSION CHECK, not a proof of the relabel)
  // =========================================================================
  {
    const t = await p.group.findUnique({ where: { id: TMBS }, select: { tax_label: true, tax_model: true, group_name: true } });
    rec('R8 TMBS unchanged: tax_label="VAT" & tax_model="vat" (data regression check)', t?.tax_label === 'VAT' && t?.tax_model === 'vat', `${t?.tax_label}/${t?.tax_model}`);
  }

  // =========================================================================
  // PHASE D — June 2026 goldens byte-identical (throwaway TMBS admin)
  // =========================================================================
  {
    const stamp2 = Date.now();
    const pw2 = 'GoldP@ss!' + stamp2; const h2 = await bcrypt.hash(pw2, 10);
    tmbsUser = await p.user.create({ data: {
      email: `zz-gate-tmbs-${stamp2}@example.com`, name: 'Gate TMBS', passwordHash: h2, role: 'ADMIN',
      is_owner: false, is_active: true, group_id: TMBS,
    }});
    const jar2 = makeJar();
    const s2 = await login(jar2, tmbsUser.email, pw2);
    if (!s2) { rec('D9 June goldens: TMBS admin login', false, 'login failed'); }
    else {
      const r = await jar2.fetch(`${HOST}/api/dashboard-tiles?from=2026-06-01&to=2026-06-30&mfrom=2026-06&mto=2026-06`);
      const data = await r.json();
      const flat = JSON.stringify(data);
      const has = (needle) => flat.includes(needle);
      // goldens: £12,940.67 / £3,612.88 / £9,327.79 / 87.25h / 51.8% / £38.86
      const checks = [
        ['£12,940.67 revenue (1294067)', has('1294067')],
        ['£3,612.88 parts cost (361288)', has('361288')],
        ['£9,327.79 gross margin (932779)', has('932779')],
        ['87.25h charged hours', has('87.25') || has('"87.25"') || has('8725')],
        ['51.8% utilisation', has('51.8')],
        ['£38.86 effective rate (3886)', has('3886')],
      ];
      for (const [label, ok] of checks) rec(`D9 June golden: ${label}`, ok, ok ? '' : 'NOT FOUND in tile payload');
      if (checks.some(([, ok]) => !ok)) { console.log('\n[tile payload for diagnosis]\n' + flat.slice(0, 4000) + '\n'); }
    }
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  const fails = results.filter((r) => !r.pass);
  console.log(`\n========== ${results.length - fails.length}/${results.length} PASS ==========`);
  if (fails.length) console.log('FAILURES:\n' + fails.map((f) => ' - ' + f.name + (f.detail ? ' (' + f.detail + ')' : '')).join('\n'));
} catch (e) {
  console.error('\n[GATE ERROR]', e);
} finally {
  // ---- teardown (order: children → parents) ----
  try {
    if (fx) {
      await p.invoiceLine.deleteMany({ where: { invoice: { group_id: fx.grpId } } });
      await p.invoice.deleteMany({ where: { group_id: fx.grpId } });
      await p.invoiceSequence.deleteMany({ where: { group_id: fx.grpId } });
      await p.jobCard.deleteMany({ where: { group_id: fx.grpId } });
      await p.vehicle.deleteMany({ where: { group_id: fx.grpId } });
      await p.customer.deleteMany({ where: { group_id: fx.grpId } });
      await p.serviceCatalogue.deleteMany({ where: { group_id: fx.grpId } });
      await p.groupBilling.deleteMany({ where: { group_id: fx.grpId } });
      await p.user.deleteMany({ where: { group_id: fx.grpId } });
      await p.group.delete({ where: { id: fx.grpId } });
      console.log('[teardown] US fixture removed');
    }
    if (tmbsUser) { await p.user.delete({ where: { id: tmbsUser.id } }); console.log('[teardown] TMBS throwaway admin removed'); }
  } catch (e) { console.error('[teardown ERROR]', e); }
  // residue check
  const left = await p.group.count({ where: { group_name: { startsWith: 'ZZ Gate US ' } } });
  const leftU = await p.user.count({ where: { email: { startsWith: 'zz-gate-' } } });
  console.log(`[residue] ZZ groups left=${left}, zz-gate users left=${leftU}`);
  await p.$disconnect();
}
