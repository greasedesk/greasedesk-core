/**
 * File: pages/api/superadmin/setup-steps.ts
 * Engine Room editing of SetupStepDef (ruling 2026-07-29). The EDITABILITY BOUNDARY is enforced
 * here, not just in the UI: an operator may change wording, order, required/enabled and country
 * scope — NEVER handler_key (what a step writes to is code). Every write lands a SuperAdminAudit
 * row. Owner-only for writes; any operator may read.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, roleAtLeast } from '@/lib/operator-auth';
import { isHandlerKey } from '@/lib/setup-wizard';

const ISO = /^[A-Z]{2}$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const op = await requireOperatorApi(req, res);
  if (!op) return;

  if (req.method === 'GET') {
    const steps = await prisma.setupStepDef.findMany({ orderBy: [{ position: 'asc' }, { step_key: 'asc' }] });
    return res.status(200).json({ steps, handlersKnown: steps.map((s: any) => ({ step_key: s.step_key, known: isHandlerKey(s.handler_key) })) });
  }

  if (req.method === 'PATCH') {
    if (!roleAtLeast(op.role, 'owner')) return res.status(404).json({ message: 'Not found.' }); // undiscoverable, per ER discipline
    const b = (req.body || {}) as any;
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const row = await prisma.setupStepDef.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ message: 'Not found.' });
    if (b.handler_key !== undefined && b.handler_key !== row.handler_key) {
      return res.status(400).json({ message: 'handler_key is code-bound and not editable.' });
    }
    const data: any = {};
    if (b.title !== undefined) { const t = String(b.title).trim(); if (!t) return res.status(400).json({ message: 'Title cannot be empty.' }); data.title = t; }
    if (b.body !== undefined) data.body = String(b.body);
    if (b.help_text !== undefined) data.help_text = String(b.help_text);
    if (b.position !== undefined) { const p = Math.trunc(Number(b.position)); if (!Number.isFinite(p)) return res.status(400).json({ message: 'Position must be a number.' }); data.position = p; }
    if (b.required !== undefined) data.required = !!b.required;
    if (b.enabled !== undefined) data.enabled = !!b.enabled;
    if (b.countries !== undefined) {
      if (b.countries === null || b.countries === '') data.countries = null;
      else {
        const arr = Array.isArray(b.countries) ? b.countries : String(b.countries).split(',');
        const clean = arr.map((c: string) => String(c).trim().toUpperCase()).filter(Boolean);
        if (!clean.every((c: string) => ISO.test(c))) return res.status(400).json({ message: 'Countries must be two-letter ISO codes.' });
        data.countries = clean.length ? clean : null;
      }
    }
    const updated = await prisma.setupStepDef.update({ where: { id }, data });
    await prisma.superAdminAudit.create({
      data: {
        operator_user_id: op.userId, action: 'setup_step.updated',
        target_group_id: null, target_operator_id: null,
        target_name_snapshot: `SetupStepDef ${row.step_key}`,
        target_ref_snapshot: row.handler_key,
        reason: JSON.stringify(Object.keys(data)),
      },
    });
    return res.status(200).json({ step: updated, message: 'Step updated.' });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
