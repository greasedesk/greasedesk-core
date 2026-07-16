/**
 * File: lib/setup-signals.ts
 * THE setup-completion model (item-13) — 8 signals, three-state, ALL derived. Powers the dashboard
 * summary, the /admin/setup panel, and the guided walkthrough (one source of truth for "what's set
 * up"). Supersedes lib/setup-checklist.
 *
 * EVERY "done" is derived from a real row/value existing — NEVER a stored setup_step_completed flag
 * (that's how state drifts; same discipline as the onboarding gate). The ONLY stored bits are the two
 * APPLICABILITY declarations (Group.employees_not_applicable / company_number_not_applicable) — a
 * sole trader marking those signals "not applicable". Applicability is a business fact the owner
 * asserts; it is NOT a done flag and is scoped to EXACTLY employees + company number.
 *
 * The 8 signals:
 *   GATED (required by onboarding — always done once past the gate): location, labour_rate, tax,
 *     subscription.
 *   OPTIONAL (post-signup): resources (derived, NOT gated), employees*, company_number*, overheads.
 *   * = the only two that can be "not applicable".
 */
import { prisma } from '@/lib/db';

export type SignalState = 'done' | 'todo' | 'not_applicable';
export type SetupSignalKey =
  | 'location' | 'labour_rate' | 'tax' | 'subscription'
  | 'resources' | 'employees' | 'company_number' | 'overheads';

export type SetupSignal = {
  key: SetupSignalKey;
  state: SignalState;
  gated: boolean;   // one of the four required-onboarding signals
  canBeNA: boolean; // true only for employees + company_number
  href: string;     // where its (single, reused) form lives
};

export type SetupSummary = {
  signals: SetupSignal[];
  applicableCount: number;   // signals that apply (excludes not_applicable)
  doneCount: number;         // applicable signals that are done
  outstanding: SetupSignal[]; // applicable signals not yet done (state === 'todo')
  allDone: boolean;          // every applicable signal is done
};

const SUBSCRIBED = new Set(['trialing', 'active']);

/** Compute all 8 signals for a tenant. Every done-state is a derived row/value check. */
export async function getSetupSignals(groupId: string, primarySiteId: string | null): Promise<SetupSummary> {
  const [
    siteCount, labourSvc, group, billing,
    resourceCount, employeeCount, overheadCount,
  ] = await Promise.all([
    prisma.site.count({ where: { group_id: groupId } }),
    prisma.serviceCatalogue.findFirst({ where: { group_id: groupId, service_code: 'LABOUR_HR', default_labour_rate: { not: null } }, select: { id: true } }),
    prisma.group.findUnique({ where: { id: groupId }, select: { tax_default_rate_bp: true, company_number: true, employees_not_applicable: true, company_number_not_applicable: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { subscription_status: true } }),
    prisma.resource.count({ where: { site: { group_id: groupId } } }),
    prisma.costPerson.count({ where: { group_id: groupId, is_active: true } }),
    prisma.overhead.count({ where: { group_id: groupId } }),
  ]);

  const diaryHref = primarySiteId ? `/admin/diary?site=${encodeURIComponent(primarySiteId)}` : '/admin/diary';

  // Three-state helper for the two NA-capable signals: done if the row exists, else NA if declared,
  // else todo. (Absence alone is NEVER "not applicable" — that needs the explicit declaration.)
  const naState = (done: boolean, declaredNA: boolean): SignalState => done ? 'done' : declaredNA ? 'not_applicable' : 'todo';

  const signals: SetupSignal[] = [
    { key: 'location',       state: siteCount > 0 ? 'done' : 'todo',                             gated: true,  canBeNA: false, href: '/admin/settings/locations' },
    { key: 'labour_rate',    state: labourSvc ? 'done' : 'todo',                                 gated: true,  canBeNA: false, href: '/admin/settings/financial' },
    { key: 'tax',            state: group?.tax_default_rate_bp != null ? 'done' : 'todo',        gated: true,  canBeNA: false, href: '/admin/settings/financial' },
    { key: 'subscription',   state: SUBSCRIBED.has(billing?.subscription_status ?? '') ? 'done' : 'todo', gated: true, canBeNA: false, href: '/admin/settings/licences' },
    { key: 'resources',      state: resourceCount > 0 ? 'done' : 'todo',                         gated: false, canBeNA: false, href: diaryHref },
    { key: 'employees',      state: naState(employeeCount > 0, !!group?.employees_not_applicable), gated: false, canBeNA: true,  href: '/admin/hr' },
    { key: 'company_number', state: naState(!!(group?.company_number && group.company_number.trim()), !!group?.company_number_not_applicable), gated: false, canBeNA: true, href: '/admin/settings/company/details' },
    { key: 'overheads',      state: overheadCount > 0 ? 'done' : 'todo',                         gated: false, canBeNA: false, href: '/admin/settings/overheads' },
  ];

  const applicable = signals.filter((s) => s.state !== 'not_applicable');
  const outstanding = signals.filter((s) => s.state === 'todo');
  return {
    signals,
    applicableCount: applicable.length,
    doneCount: applicable.filter((s) => s.state === 'done').length,
    outstanding,
    allDone: outstanding.length === 0,
  };
}
