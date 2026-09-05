/**
 * File: pages/superadmin/tenants/[id].tsx
 * Engine Room — a single tenant's detail. READ-ONLY. No edit controls in this slice.
 *
 * SCOPE BOUNDARY (enforced in the QUERY, not the UI): this exposes the tenant's OWN business account
 * data, for which the operator is CONTROLLER. It must NEVER expose the tenant's end-customer records —
 * customers, vehicles, job cards, invoices — for which the operator is a PROCESSOR (Privacy Policy +
 * Terms). Concretely:
 *   • Users select STAFF ONLY (customerId: null) and NEVER read customerId or the customer relation.
 *   • Last activity reads created_at ONLY from AuditLog — never action, never diff_json (which carry
 *     end-customer names, phones, VINs).
 *   • Job cards + invoices are count() ONLY — no row contents reach this page.
 * Region-scoped from the principal: a tenant outside the operator's regions is a 404 (undiscoverable),
 * not a 403 — matching the rest of the Engine Room.
 *
 * AUDIT THE READ: every load writes a SuperAdminAudit `tenant.viewed` row (operator, tenant, time).
 * Viewing a customer's business data is an access event; a refresh is a fresh access. Under-recording
 * is the worse failure, so it is per-load, not once-per-session.
 *
 * HONEST-NULL: an unsupplied field renders an explicit "not supplied" — never blank, never zero. The
 * operator must be able to tell missing from empty, since that is often why they are looking.
 */
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { taxDisplay } from '@/lib/tax';
import { prisma } from '@/lib/db';
import React from 'react';
import { useRouter } from 'next/router';
import { requireOperatorPage, operatorTenantScope, type OperatorRoleName } from '@/lib/operator-auth';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { PHONE_STEP_REQUIRED_FROM } from '@/lib/onboarding';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type SiteRow = { name: string; address: string | null; phone: string | null; currency: string; hours: string | null; labourRate: number | null };
type UserRow = { id: string; name: string | null; email: string; role: string; active: boolean; twoFactorEnabled: boolean };
// Company number is a THREE-state value, never collapsed: a real number, legitimately 'na' (sole
// traders have none, flag set), or 'missing' (neither supplied).
type CompanyNumber = { kind: 'value'; value: string } | { kind: 'na' } | { kind: 'missing' };

type Detail = {
  id: string; ref: string; isInternal: boolean; isTmbs: boolean;
  business: {
    tradingName: string | null; legalName: string; companyNumber: CompanyNumber;
    vatNumber: string | null; vatRegistered: boolean; country: string | null;
    currency: string | null; taxRatePct: number | null;
    /** Both tax rows, shaped once in lib/tax so the page cannot spell the regime its own way. */
    tax: { label: string; regimeLabel: string; regimeValue: string; registrationLabel: string; registrationValue: string };
  };
  contact: { address: string | null; phone: string | null; email: string };
  sites: SiteRow[];
  users: UserRow[];
  account: {
    created: string; subscriptionStatus: string | null; tenantStatus: string; trialEnds: string | null;
    modules: string[]; signupSource: string; lastActivity: string | null;
    phoneExempt: { at: string; reason: string | null } | null;
    phoneStepApplies: boolean;
    counts: { sites: number; users: number; jobCards: number; invoices: number };
  };
  /** Accruals the commission engine refused for this tenant, still open. Money a rep is owed. */
  refusals: Array<{ id: string; sourceRef: string; code: string; message: string; occurredAt: string }>;
};
type PageProps = { role: OperatorRoleName; operatorEmail: string; d: Detail };

const NS = 'not supplied';
const Muted = ({ children }: { children: React.ReactNode }) => <span style={{ color: '#7C8AA3', fontStyle: 'italic' }}>{children}</span>;
const V = ({ v }: { v: string | number | null | undefined }) =>
  v === null || v === undefined || v === '' ? <Muted>{NS}</Muted> : <>{v}</>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2" style={{ borderBottom: '1px solid #16294733' }}>
      <div className="text-xs mb-0.5" style={{ color: '#7C8AA3' }}>{label}</div>
      <div className="text-sm text-white">{children}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: '#0E2340', border: '1px solid #1C3257' }}>
      <h2 className="text-sm font-semibold text-white mb-2">{title}</h2>
      {children}
    </div>
  );
}

export default function TenantDetail({ role, operatorEmail, d }: PageProps) {
  const b = d.business, a = d.account;
  const router = useRouter();
  const [busy2fa, setBusy2fa] = React.useState<string | null>(null);
  const [busyExempt, setBusyExempt] = React.useState(false);

  // DISABLE-ONLY, and the confirm says so in the operator's own terms: this is a support action on
  // someone else's business, so it names the person and states the consequence before it happens.
  async function reset2fa(userId: string, email: string) {
    if (!confirm(`Reset two-factor authentication for ${email}?\n\nThey will sign in with their password alone until they set it up again. Use this ONLY when the account holder has lost both their phone and their recovery codes.\n\nThis is recorded against your operator account and in the garage's own audit trail.`)) return;
    setBusy2fa(userId);
    try {
      const r = await fetch('/api/superadmin/tenant-2fa-reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
      });
      const j = await r.json().catch(() => ({}));
      alert(j?.message || (r.ok ? 'Done.' : 'Could not reset two-factor authentication.'));
      if (r.ok) router.replace(router.asPath);
    } finally { setBusy2fa(null); } // never strand the busy flag
  }

  // ── BREAK-GLASS ON A MANDATORY STEP ──────────────────────────────────────────────────────────
  // The phone step blocks signup, and the panel tells a stuck garage to phone us — so whoever picks
  // up has to be able to finish the call. An API with no button is not a break-glass; it is a
  // promise that somebody else will run a script.
  //
  // It exempts. It never verifies: see the endpoint header. The confirm says so in as many words,
  // because the operator's instinct will be that they have just "sorted their phone out".
  async function setPhoneExempt(revoke: boolean) {
    let reason = '';
    if (!revoke) {
      reason = window.prompt(
        `Exempt ${d.business.tradingName || d.business.legalName} from the phone step?\n\n`
        + 'They will reach checkout with NO phone number recorded — this does not confirm a number and never will.\n\n'
        + 'Why can they not complete it? (recorded against your operator account and theirs)',
      ) ?? '';
      if (!reason.trim()) return;
    } else if (!confirm('Remove the exemption? The phone step will apply to their admins again.')) {
      return;
    }
    setBusyExempt(true);
    try {
      const r = await fetch('/api/superadmin/tenant-phone-exempt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: d.id, reason, revoke }),
      });
      const j = await r.json().catch(() => ({}));
      alert(j?.message || (r.ok ? 'Done.' : 'Could not change the exemption.'));
      if (r.ok) router.replace(router.asPath);
    } finally { setBusyExempt(false); } // never strand the busy flag
  }

  const companyNumber =
    d.business.companyNumber.kind === 'value' ? <V v={d.business.companyNumber.value} />
    : d.business.companyNumber.kind === 'na' ? <span style={{ color: '#7C8AA3' }}>not applicable</span>
    : <Muted>{NS}</Muted>;

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — {d.business.legalName}</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6" style={{ color: '#C7D2E1' }}>
        <div className="max-w-4xl">
          <div className="mb-4">
            <Link href="/superadmin/tenants" className="text-xs underline" style={{ color: '#8AB4F8' }}>← All tenants</Link>
          </div>
          <div className="flex items-baseline justify-between mb-5">
            <h1 className="text-xl font-semibold text-white">
              {d.business.tradingName || d.business.legalName}
              {d.isInternal && <span className="ml-2 text-xs px-2 py-0.5 rounded" style={{ background: '#3A2A0B', color: '#FCD34D', border: '1px solid #6b5010' }}>internal</span>}
              {d.isTmbs && <span className="ml-2 text-xs" style={{ color: '#FCD34D' }}>★live</span>}
            </h1>
            <span className="text-xs" style={{ color: '#7C8AA3' }}>{operatorEmail} · read-only</span>
          </div>

          <Section title="Business">
            <Field label="Trading name"><V v={b.tradingName} /></Field>
            <Field label="Legal / company name"><V v={b.legalName} /></Field>
            <Field label="Tenant ref">{d.ref}</Field>
            <Field label="Group ID"><span className="text-xs" style={{ color: '#9FB0C9' }}>{d.id}</span></Field>
            <Field label="Company number">{companyNumber}</Field>
            <Field label={`${b.tax.label} number`}><V v={b.vatNumber} /></Field>
            {/* BOTH ROWS FROM ONE SHAPER (lib/tax::taxDisplay). They used to be a hardcoded "VAT
                registration" and the raw enum, which printed "Not registered" under "vat" as though
                one denied the other — and asked a US garage about a tax its country does not have. */}
            <Field label={b.tax.registrationLabel}>{b.tax.registrationValue}</Field>
            <Field label="Country"><V v={b.country} /></Field>
            <Field label="Currency"><V v={b.currency} /></Field>
            <Field label={b.tax.regimeLabel}>{b.tax.regimeValue}</Field>
            <Field label="Tax rate">{b.taxRatePct === null ? <Muted>{NS}</Muted> : `${b.taxRatePct}%`}</Field>
          </Section>

          <Section title="Contact">
            <Field label="Address"><V v={d.contact.address} /></Field>
            <Field label="Phone"><V v={d.contact.phone} /></Field>
            <Field label="Primary contact email"><V v={d.contact.email} /></Field>
          </Section>

          <Section title={`Sites (${d.sites.length})`}>
            {d.sites.length === 0 ? <Muted>{NS}</Muted> : d.sites.map((s, i) => (
              <div key={i} className="py-2" style={{ borderBottom: '1px solid #16294733' }}>
                <div className="text-sm text-white font-medium">{s.name}</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-1 text-xs">
                  <div><span style={{ color: '#7C8AA3' }}>Address: </span><V v={s.address} /></div>
                  <div><span style={{ color: '#7C8AA3' }}>Phone: </span><V v={s.phone} /></div>
                  <div><span style={{ color: '#7C8AA3' }}>Currency: </span><V v={s.currency} /></div>
                  <div><span style={{ color: '#7C8AA3' }}>Opening hours: </span><V v={s.hours} /></div>
                  <div><span style={{ color: '#7C8AA3' }}>Labour rate: </span>{s.labourRate === null ? <Muted>{NS}</Muted> : `£${s.labourRate.toFixed(2)}/hr`}</div>
                </div>
              </div>
            ))}
          </Section>

          <Section title={`Users (${d.users.length})`}>
            {d.users.length === 0 ? <Muted>{NS}</Muted> : (
              <table className="w-full text-sm">
                <thead style={{ color: '#7C8AA3' }}><tr className="text-left text-xs">
                  <th className="py-1 font-medium">Name</th><th className="py-1 font-medium">Email</th><th className="py-1 font-medium">Role</th><th className="py-1 font-medium">Status</th><th className="py-1 font-medium">2FA</th>
                </tr></thead>
                <tbody>
                  {d.users.map((u, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #16294733' }}>
                      <td className="py-1.5 text-white">{u.name ? u.name : <Muted>{NS}</Muted>}</td>
                      <td className="py-1.5">{u.email}</td>
                      <td className="py-1.5">{u.role}</td>
                      <td className="py-1.5">{u.active ? 'Active' : <span style={{ color: '#FCA5A5' }}>Deactivated</span>}</td>
                      {/* SUPPORT ACTION, DISABLE-ONLY. The sole owner of a single-admin garage has
                          nobody above them; without this their only remedy is a hand-written DELETE
                          against production. There is deliberately no way to turn 2FA ON from here. */}
                      <td className="py-1.5">
                        {u.twoFactorEnabled ? (
                          <button type="button" disabled={busy2fa === u.id} data-testid={`er-reset-2fa-${u.email}`}
                            onClick={() => reset2fa(u.id, u.email)}
                            style={{ color: '#FCD34D' }} className="text-xs hover:underline disabled:opacity-40">
                            {busy2fa === u.id ? 'Resetting…' : '🔒 on — Reset'}
                          </button>
                        ) : <Muted>off</Muted>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* ── COMMISSION NOT ACCRUED ──────────────────────────────────────────────────────
              Shown ONLY when there is something to show: a permanently empty "no problems" panel
              on every tenant is furniture, and this is the page an operator opens when they are
              already looking for something. The dashboard tile is the thing that says "go look". */}
          {d.refusals.length > 0 && (
            <div className="rounded-xl p-4 mb-4" style={{ background: '#2A1D06', border: '1px solid #7A5A16' }} data-testid="er-tenant-refusals">
              <h2 className="text-sm font-semibold text-amber-200 mb-1">Commission not accrued ({d.refusals.length})</h2>
              <p className="text-xs text-amber-200/70 mb-2">
                The engine refused to accrue commission on these payments rather than invent a figure.
                A rep is owed and unpaid until the cause is fixed and the payment re-processed.
              </p>
              <ul className="space-y-2">
                {d.refusals.map((r) => (
                  <li key={r.id} className="text-xs text-amber-100/90" data-testid={`er-refusal-${r.code}`}>
                    <span className="font-mono text-amber-200">{r.code}</span>
                    <span className="text-amber-200/60"> · {new Date(r.occurredAt).toLocaleString('en-GB', { timeZone: 'UTC' })} · payment {r.sourceRef}</span>
                    <div className="text-amber-100/70">{r.message}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Section title="Account">
            <Field label="Created">{new Date(a.created).toLocaleDateString('en-GB')}</Field>
            <Field label="Tenant status">{a.tenantStatus}</Field>
            <Field label="Subscription status"><V v={a.subscriptionStatus} /></Field>
            <Field label="Trial ends">{a.trialEnds ? new Date(a.trialEnds).toLocaleDateString('en-GB') : <Muted>{NS}</Muted>}</Field>
            <Field label="Modules entitled">{a.modules.length ? a.modules.join(', ') : <Muted>{NS}</Muted>}</Field>
            <Field label="Signup source">{a.signupSource}</Field>
            <Field label="Phone step">
              {a.phoneExempt ? (
                <>
                  <span style={{ color: '#FCD34D' }}>Exempt</span>
                  <span className="text-xs ml-2" style={{ color: '#7C8AA3' }}>
                    since {new Date(a.phoneExempt.at).toLocaleDateString('en-GB')} · {a.phoneExempt.reason || 'no reason recorded'}
                  </span>
                  <button type="button" disabled={busyExempt} onClick={() => setPhoneExempt(true)}
                    data-testid="er-phone-exempt-revoke"
                    className="text-xs ml-3 hover:underline disabled:opacity-40" style={{ color: '#8AB4F8' }}>
                    {busyExempt ? 'Working…' : 'Remove exemption'}
                  </button>
                </>
              ) : (
                <>
                  {a.phoneStepApplies
                    ? 'Required at signup'
                    : <span style={{ color: '#7C8AA3' }}>Not required — signed up before the step existed</span>}
                  <button type="button" disabled={busyExempt} onClick={() => setPhoneExempt(false)}
                    data-testid="er-phone-exempt"
                    className="text-xs ml-3 hover:underline disabled:opacity-40" style={{ color: '#FCD34D' }}>
                    {busyExempt ? 'Working…' : 'Exempt'}
                  </button>
                </>
              )}
            </Field>
            <Field label="Last activity">
              {a.lastActivity ? new Date(a.lastActivity).toLocaleString('en-GB') : <Muted>none recorded</Muted>}
              <span className="text-xs ml-2" style={{ color: '#7C8AA3' }}>· basis: most recent recorded action in the tenant's audit log</span>
            </Field>
            <Field label="Counts">
              <span className="tabular-nums">{a.counts.sites} sites · {a.counts.users} users · {a.counts.jobCards} job cards · {a.counts.invoices} invoices</span>
            </Field>
          </Section>
        </div>
      </div>
    </EngineRoomLayout>
  );
}

const fmtHours = (openHour: number | null, closeHour: number | null): string | null =>
  openHour == null || closeHour == null ? null : `${String(openHour).padStart(2, '0')}:00–${String(closeHour).padStart(2, '0')}:00`;

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx);
  if (!gate.ok) return { notFound: true }; // 404 — wrong actor class

  const id = String(ctx.params?.id ?? '');
  // REGION-SCOPED: id AND the operator's scope. A tenant outside scope (or a bad id) → the row simply
  // isn't found → 404. Undiscoverable, never a 403 that would confirm the tenant exists.
  const g = (await prisma.group.findFirst({
    where: { id, ...operatorTenantScope(gate.op) },
    select: {
      id: true, ref: true, group_name: true, trading_name: true, company_number: true,
      company_number_not_applicable: true, vat_number: true, vat_registered: true, country_code: true,
      tax_model: true, tax_label: true, tax_default_rate_bp: true, default_vat_rate: true, address: true, phone: true,
      billing_email: true, created_at: true, status: true, trial_ends_at: true, signup_ref: true,
      phone_step_exempt_at: true, phone_step_exempt_reason: true,
      is_internal: true,
      billing: { select: { subscription_status: true } },
      sites: {
        orderBy: { created_at: 'asc' },
        select: { id: true, site_name: true, address: true, phone: true, currency_code: true, open_hour: true, close_hour: true },
      },
    },
  })) as any;
  if (!g) return { notFound: true };

  // OPEN refusals for this tenant, newest first. Scoped by the group we have already proven the
  // operator may see, so this adds no new access surface.
  const refusalRows = await (prisma as any).commissionRefusal.findMany({
    where: { group_id: g.id, resolved_at: null },
    orderBy: { occurred_at: 'desc' },
    select: { id: true, source_ref: true, code: true, message: true, occurred_at: true },
  });

  // AUDIT THE READ (per-load) — before returning props, from the operator principal. FAIL CLOSED: this
  // is NOT wrapped in a catch. If the access record cannot be written, the view must not render — an
  // unaudited look at a customer's business data is the failure we are guarding against (break-glass
  // credentials make the trail the only after-the-fact check). Under-recording is the worse failure.
  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: gate.op.userId,
      action: 'tenant.viewed',
      target_group_id: g.id,
      target_name_snapshot: g.group_name,
      target_ref_snapshot: g.ref,
    },
  });

  // Labour rate per site — lives on ServiceCatalogue (LABOUR_HR), NOT on Site. Honest-null when absent.
  const labourRows = (await prisma.serviceCatalogue.findMany({
    where: { group_id: g.id, service_code: 'LABOUR_HR', default_labour_rate: { not: null } },
    select: { site_id: true, default_labour_rate: true },
  })) as Array<{ site_id: string | null; default_labour_rate: any }>;
  const labourBySite = new Map(labourRows.filter((r) => r.site_id).map((r) => [r.site_id as string, Number(r.default_labour_rate)]));

  // Users — STAFF ONLY. customerId: null excludes any customer-portal-linked account; customerId and
  // the customer relation are never selected.
  const users = (await prisma.user.findMany({
    where: { group_id: g.id, customerId: null },
    orderBy: { email: 'asc' },
    select: { id: true, name: true, email: true, role: true, is_active: true },
  })) as Array<{ id: string; name: string | null; email: string; role: string; is_active: boolean }>;
  // Which of them hold a second factor — one query, from the subject-keyed table.
  const tenant2fa = new Set(
    (await prisma.twoFactorSecret.findMany({
      where: { subject_type: 'tenant', enabled: true, subject_id: { in: users.map((u) => u.id) } },
      select: { subject_id: true },
    })).map((r: { subject_id: string }) => r.subject_id),
  );

  const modules = (await prisma.groupFeature.findMany({
    where: { group_id: g.id, enabled: true }, select: { feature_key: true },
  })).map((f: { feature_key: string }) => f.feature_key);

  // Signup source — DERIVED from signup_ref + attribution (+ waitlist), not a single field.
  const [attribCount, waitlistCount, staffUserCount, jobCardCount, invoiceCount, lastAct] = await Promise.all([
    prisma.tenantAttribution.count({ where: { group_id: g.id, ended_at: null } }),
    prisma.countryWaitlist.count({ where: { group_id: g.id } }).catch(() => 0),
    prisma.user.count({ where: { group_id: g.id, customerId: null } }),
    prisma.jobCard.count({ where: { group_id: g.id } }),   // COUNT ONLY — no contents
    prisma.invoice.count({ where: { group_id: g.id } }),   // COUNT ONLY — no contents
    prisma.auditLog.aggregate({ where: { group_id: g.id }, _max: { created_at: true } }), // created_at ONLY
  ]);
  const ref = g.signup_ref as string | null;
  const signupSource = attribCount > 0 ? `Reseller${ref ? ` (ref ${ref})` : ''}`
    : ref ? `Referral (ref ${ref})`
    : waitlistCount > 0 ? 'Waitlist'
    : 'Direct';

  const operator = await prisma.operator.findUnique({ where: { id: gate.op.userId }, select: { email: true } });
  const currencies = Array.from(new Set(g.sites.map((s: any) => s.currency_code).filter(Boolean)));
  const taxRatePct = g.tax_default_rate_bp != null ? g.tax_default_rate_bp / 100
    : g.default_vat_rate != null ? Number(g.default_vat_rate) : null;

  const companyNumber: CompanyNumber = g.company_number
    ? { kind: 'value', value: g.company_number }
    : g.company_number_not_applicable ? { kind: 'na' } : { kind: 'missing' };

  return {
    props: {
      role: gate.op.role,
      operatorEmail: operator?.email ?? '—',
      d: {
        id: g.id, ref: g.ref, isInternal: g.is_internal === true, isTmbs: g.id === TMBS_GROUP_ID,
        business: {
          tradingName: g.trading_name ?? null, legalName: g.group_name, companyNumber,
          vatNumber: g.vat_number ?? null, vatRegistered: !!g.vat_registered, country: g.country_code ?? null,
          currency: currencies.length ? currencies.join(', ') : null, taxRatePct,
          tax: { label: (g.tax_label ?? '').trim() || 'Tax',
            ...taxDisplay({ taxLabel: g.tax_label, countryCode: g.country_code, isRegistered: !!g.vat_registered }) },
        },
        contact: { address: g.address ?? null, phone: g.phone ?? null, email: g.billing_email },
        sites: g.sites.map((s: any) => ({
          name: s.site_name, address: s.address ?? null, phone: s.phone ?? null,
          currency: s.currency_code, hours: fmtHours(s.open_hour, s.close_hour),
          labourRate: labourBySite.has(s.id) ? labourBySite.get(s.id)! : null,
        })),
        users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.is_active, twoFactorEnabled: tenant2fa.has(u.id) })),
        account: {
          created: (g.created_at as Date).toISOString(),
          subscriptionStatus: g.billing?.subscription_status ?? null,
          tenantStatus: g.status,
          trialEnds: g.trial_ends_at ? (g.trial_ends_at as Date).toISOString() : null,
          modules, signupSource,
          // The exemption is shown WITH its reason, because an exemption nobody can explain is
          // indistinguishable from a mistake when it is found months later.
          phoneExempt: g.phone_step_exempt_at
            ? { at: (g.phone_step_exempt_at as Date).toISOString(), reason: g.phone_step_exempt_reason ?? null }
            : null,
          phoneStepApplies: (g.created_at as Date) >= PHONE_STEP_REQUIRED_FROM,
          lastActivity: lastAct._max.created_at ? (lastAct._max.created_at as Date).toISOString() : null,
          counts: { sites: g.sites.length, users: staffUserCount, jobCards: jobCardCount, invoices: invoiceCount },
        },
        refusals: refusalRows.map((r: any) => ({
          id: r.id, sourceRef: r.source_ref, code: r.code, message: r.message,
          occurredAt: (r.occurred_at as Date).toISOString(),
        })),
      },
    },
  };
};
