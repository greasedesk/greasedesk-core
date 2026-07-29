/**
 * File: lib/setup-wizard.ts
 * THE setup-wizard spine (ruling 2026-07-29). The EDITABILITY BOUNDARY lives here:
 *
 *   OPERATOR-EDITABLE (SetupStepDef rows, Engine Room): title, body, help text, order, required,
 *   enabled, country scope.
 *   CODE (this registry): what a step writes to, its render component, its completion derivation,
 *   and ordering constraints. An unknown/retired handler_key FAILS CLOSED — the step is dropped
 *   from the resolved list with a logged warning; it can never render a question that writes
 *   nowhere or wrongly (that would silently corrupt capacity or the P&L).
 *
 * Steps carry NO stored cursor — the resume point is DERIVED (first enabled required step whose
 * handler reports incomplete), same discipline as lib/setup-signals.
 */
import { prisma } from '@/lib/db';
import type { CountryProfile } from '@/lib/locale-profiles';

export type HandlerKey =
  | 'resources_lifts'
  | 'resources_booths'
  | 'resources_other'
  | 'technicians'
  | 'overheads_basic'
  | 'contact_details';

/** The fixed registry. `mustFollow` is the partial-order constraint operator ordering cannot
 *  violate — a step is clamped after every step it must follow, whatever position says. */
export const WIZARD_HANDLERS: Record<HandlerKey, { mustFollow: HandlerKey[] }> = {
  resources_lifts: { mustFollow: [] },
  resources_booths: { mustFollow: [] },
  resources_other: { mustFollow: [] },
  technicians: { mustFollow: [] },
  overheads_basic: { mustFollow: [] },
  contact_details: { mustFollow: [] },
};

export const isHandlerKey = (k: string): k is HandlerKey => k in WIZARD_HANDLERS;

export type ResolvedStep = {
  stepKey: string;
  handlerKey: HandlerKey;
  title: string;
  body: string;
  helpText: string;
  required: boolean;
  position: number;
};

/** {{token}} interpolation from the country profile — one template reads correctly everywhere. */
export function interpolate(text: string, profile: CountryProfile): string {
  const tokens: Record<string, string> = {
    currencySymbol: profile.currencySymbol,
    currency: profile.currency,
    taxLabel: profile.taxLabel,
    postcodeLabel: profile.postcodeLabel,
    phonePlaceholder: profile.phonePlaceholder,
    testName: profile.roadworthiness_test_name,
    countryName: profile.name,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => tokens[k] ?? '');
}

/**
 * Resolve the enabled steps for a tenant country. Country scoping: per handler_key, a step whose
 * `countries` includes the tenant country beats an unscoped (NULL) one; a handler with only
 * foreign-scoped rows contributes nothing (the hide-for-IE case). Unknown handler keys are
 * dropped, loudly.
 */
type StepDefRow = { id: string; step_key: string; handler_key: string; title: string; body: string; help_text: string; position: number; required: boolean; enabled: boolean; countries: unknown; updated_at: Date };

export async function resolveWizardSteps(profile: CountryProfile): Promise<ResolvedStep[]> {
  const defs: StepDefRow[] = await prisma.setupStepDef.findMany({ where: { enabled: true }, orderBy: [{ position: 'asc' }, { step_key: 'asc' }] });
  const byHandler = new Map<string, StepDefRow[]>();
  for (const d of defs) {
    const list = byHandler.get(d.handler_key) ?? [];
    list.push(d);
    byHandler.set(d.handler_key, list);
  }
  const chosen: StepDefRow[] = [];
  for (const [handler, list] of byHandler) {
    if (!isHandlerKey(handler)) {
      console.warn(`[setup-wizard] unknown handler_key "${handler}" (${list.length} step def(s)) — dropped, fail-closed`);
      continue;
    }
    const scoped = list.filter((d: StepDefRow) => Array.isArray(d.countries) && (d.countries as string[]).includes(profile.countryCode));
    const unscoped = list.filter((d: StepDefRow) => d.countries == null);
    const pick = scoped.length ? scoped : unscoped; // foreign-scoped-only → nothing renders
    chosen.push(...pick);
  }
  chosen.sort((a: StepDefRow, b: StepDefRow) => a.position - b.position || a.step_key.localeCompare(b.step_key));

  // Enforce the registry's partial order: a step is moved after the last step it must follow.
  const ordered: StepDefRow[] = [];
  for (const d of chosen) {
    const must = WIZARD_HANDLERS[d.handler_key as HandlerKey].mustFollow;
    let insertAt = ordered.length;
    void must; // constraint list is empty for the launch six; the clamp below activates when used
    ordered.splice(insertAt, 0, d);
  }
  for (let i = 0; i < ordered.length; i++) {
    const must = WIZARD_HANDLERS[ordered[i].handler_key as HandlerKey].mustFollow;
    for (const dep of must) {
      const depIdx = ordered.findIndex((d: StepDefRow) => d.handler_key === dep);
      if (depIdx > i) { const [row] = ordered.splice(i, 1); ordered.splice(depIdx, 0, row); i--; break; }
    }
  }

  return ordered.map((d: StepDefRow) => ({
    stepKey: d.step_key,
    handlerKey: d.handler_key as HandlerKey,
    title: interpolate(d.title, profile),
    body: interpolate(d.body, profile),
    helpText: interpolate(d.help_text, profile),
    required: d.required,
    position: d.position,
  }));
}
