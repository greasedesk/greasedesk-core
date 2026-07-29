/**
 * File: pages/api/setup-wizard.ts
 * The tenant-facing wizard API (ruling 2026-07-29). ADMIN-only.
 *
 *   GET  → resolved steps for the tenant's country (operator wording, profile-interpolated) +
 *          per-handler CURRENT STATE + derived completeness + the derived resume step. No cursor
 *          is stored anywhere — resume = first enabled REQUIRED step whose handler is incomplete.
 *   POST → the RESOURCE reconcilers. Counts reconcile against ACTIVE rows of the type — submitting
 *          4 twice is 4, never 8; lowering deactivates surplus (never deletes — diary history
 *          references resources); list mode (other) updates in place by id.
 *
 * Technicians write via /api/setup-wizard/technician (create+invite) and /api/headcount (edit /
 * mark-left); overheads via /api/overheads; contact via /api/company — the EXISTING models, no
 * parallels.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireAdminApi, requireCanWrite } from '@/lib/admin-guard';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { resolveWizardSteps, type HandlerKey } from '@/lib/setup-wizard';

const COUNT_TYPES: Partial<Record<HandlerKey, { type: 'lift' | 'spray_booth'; label: string }>> = {
  resources_lifts: { type: 'lift', label: 'Lift' },
  resources_booths: { type: 'spray_booth', label: 'Spray booth' },
};
const OTHER_TYPES = ['mot_bay', 'other'] as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  const groupId = vis.groupId as string;
  const siteId = vis.primarySiteId;
  if (!siteId) return res.status(400).json({ message: 'No location yet — complete onboarding first.' });

  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true, ref: true, phone: true, whatsapp: true } });
  const profile = resolveTenantProfile(group);

  if (req.method === 'GET') {
    const [steps, resourcesRaw, peopleRaw, overheadsRaw] = await Promise.all([
      resolveWizardSteps(profile),
      prisma.resource.findMany({ where: { site_id: siteId }, orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }], select: { id: true, name: true, type: true, is_active: true } }),
      prisma.costPerson.findMany({
        where: { group_id: groupId },
        orderBy: { created_at: 'asc' },
        select: {
          id: true, name: true, role: true, amount_pennies: true, cost_type: true, is_active: true,
          is_chargeable: true, contracted_hours_per_day: true, working_days: true, start_date: true, user_id: true,
          user: { select: { email: true, role: true, can_invoice: true, is_active: true } },
        },
      }),
      prisma.overhead.findMany({ where: { group_id: groupId, is_active: true }, orderBy: { created_at: 'asc' }, select: { id: true, name: true, ex_vat_amount_pennies: true, vat_rate: true, period: true } }),
    ]);

    const resources = resourcesRaw as Array<{ id: string; name: string; type: string; is_active: boolean }>;
    const people = peopleRaw as any[];
    const overheads = overheadsRaw as Array<{ id: string; name: string; ex_vat_amount_pennies: number; vat_rate: unknown; period: string }>;
    const byType = (t: string) => resources.filter((r) => r.type === t);
    const active = (rs: typeof resources) => rs.filter((r) => r.is_active);
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { open_days: true } });

    const state: Record<string, unknown> = {
      resources_lifts: { count: active(byType('lift')).length, items: byType('lift') },
      resources_booths: { count: active(byType('spray_booth')).length, items: byType('spray_booth') },
      resources_other: { items: resources.filter((r) => (OTHER_TYPES as readonly string[]).includes(r.type)) },
      technicians: {
        siteOpenDays: site?.open_days?.length ? site.open_days : [1, 2, 3, 4, 5, 6],
        people: people.map((p: any) => ({
          id: p.id, name: p.name, role: p.role, salaryPennies: p.amount_pennies, costType: p.cost_type,
          isChargeable: p.is_chargeable, hoursPerDay: p.contracted_hours_per_day == null ? null : Number(p.contracted_hours_per_day),
          workingDays: p.working_days, startDate: p.start_date ? p.start_date.toISOString().slice(0, 10) : null,
          left: !p.is_active, // leaver: greyed, never re-invited, never resurrected
          login: p.user ? { email: p.user.email, role: p.user.role, canInvoice: p.user.can_invoice, status: p.user.is_active ? 'active' : 'invited' } : null,
        })),
      },
      overheads_basic: { items: overheads.map((o: any) => ({ id: o.id, name: o.name, exVatAmountPennies: o.ex_vat_amount_pennies, vatRate: Number(o.vat_rate), period: o.period })) },
      contact_details: { phone: group?.phone ?? '', whatsapp: group?.whatsapp ?? '' },
    };

    const complete: Record<string, boolean> = {
      resources_lifts: active(byType('lift')).length > 0,
      resources_booths: active(byType('spray_booth')).length > 0,
      resources_other: resources.some((r) => (OTHER_TYPES as readonly string[]).includes(r.type) && r.is_active),
      technicians: people.some((p: any) => p.is_active),
      overheads_basic: overheads.length > 0,
      contact_details: !!(group?.phone || group?.whatsapp),
    };

    // Derived resume: first enabled REQUIRED step whose handler is incomplete (no stored cursor).
    const resume = steps.find((s) => s.required && !complete[s.handlerKey])?.stepKey ?? null;

    return res.status(200).json({
      steps: steps.map((s) => ({ ...s, complete: complete[s.handlerKey] ?? false })),
      state, resumeKey: resume,
      phonePlaceholder: profile.phonePlaceholder,
      currencySymbol: profile.currencySymbol,
      primarySiteId: siteId,
    });
  }

  if (req.method === 'POST') {
    if (!(await requireCanWrite(groupId, res))) return;
    const body = (req.body || {}) as { handler?: string; count?: number; items?: Array<{ id?: string; name?: string; type?: string; active?: boolean }> };
    const handler = String(body.handler ?? '');

    // ---- COUNT reconcile (lifts / booths): idempotent against the ACTIVE count ----
    const countCfg = COUNT_TYPES[handler as HandlerKey];
    if (countCfg) {
      const want = Math.trunc(Number(body.count));
      if (!Number.isFinite(want) || want < 0 || want > 50) return res.status(400).json({ message: 'Enter a count between 0 and 50.' });
      const rows: any[] = await prisma.resource.findMany({ where: { site_id: siteId, type: countCfg.type as any }, orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }] });
      const activeRows = rows.filter((r) => r.is_active);
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (want > activeRows.length) {
          // Reactivate deactivated rows first (a lowered count raised again restores, not duplicates)
          const inactive = rows.filter((r) => !r.is_active);
          const toReactivate = inactive.slice(0, want - activeRows.length);
          for (const r of toReactivate) await tx.resource.update({ where: { id: r.id }, data: { is_active: true } });
          const stillShort = want - activeRows.length - toReactivate.length;
          const maxOrder = rows.reduce((m, r) => Math.max(m, r.display_order), 0);
          for (let i = 0; i < stillShort; i++) {
            await tx.resource.create({ data: { site_id: siteId, type: countCfg.type as any, name: `${countCfg.label} ${rows.length + i + 1}`, display_order: maxOrder + i + 1 } });
          }
        } else if (want < activeRows.length) {
          // Deactivate surplus from the end — NEVER delete (diary history references resources).
          for (const r of activeRows.slice(want)) await tx.resource.update({ where: { id: r.id }, data: { is_active: false } });
        }
      });
      const after = await prisma.resource.count({ where: { site_id: siteId, type: countCfg.type as any, is_active: true } });
      return res.status(200).json({ message: 'Saved.', activeCount: after });
    }

    // ---- LIST reconcile (other bookable resources): update-in-place by id, add id-less ----
    if (handler === 'resources_other') {
      const items = Array.isArray(body.items) ? body.items : [];
      const existing: any[] = await prisma.resource.findMany({ where: { site_id: siteId, type: { in: OTHER_TYPES as any } }, select: { id: true, display_order: true } });
      const known = new Set(existing.map((r) => r.id));
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        let order = existing.reduce((m, r) => Math.max(m, r.display_order), 0);
        for (const it of items) {
          const name = String(it.name ?? '').trim();
          if (it.id) {
            if (!known.has(it.id)) continue; // foreign/stale id — ignored, never created
            await tx.resource.update({ where: { id: it.id }, data: { ...(name && { name }), ...(it.active !== undefined && { is_active: !!it.active }) } });
          } else if (name) {
            const type = it.type === 'mot_bay' ? 'mot_bay' : 'other';
            await tx.resource.create({ data: { site_id: siteId, type: type as any, name, display_order: ++order } });
          }
        }
      });
      return res.status(200).json({ message: 'Saved.' });
    }

    return res.status(400).json({ message: 'Unknown handler.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
