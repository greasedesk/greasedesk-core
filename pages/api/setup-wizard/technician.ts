/**
 * File: pages/api/setup-wizard/technician.ts
 * Wizard technician CREATE (ruling 2026-07-29): CostPerson (+ capacity fields + `started` event via
 * THE employment-events chokepoint) and — unless payroll-only — a pending User with an invite,
 * ALL in one transaction; the team_invite email goes through the sendNotification chokepoint after
 * commit (its first sender — the template had been waiting).
 *
 * Edits and mark-as-left go through /api/headcount from the client (dual-write + effective dating
 * come free there); this route exists only because headcount knows nothing about Users/invites.
 * Leavers are surfaced by GET /api/setup-wizard as left:true — the UI greys them; nothing here can
 * resurrect or re-invite them (create is email-deduped against ALL users).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireAdminApi, requireCanWrite } from '@/lib/admin-guard';
import { recordEmploymentEvents } from '@/lib/employment-events';
import { makeInviteToken } from '@/lib/tokens';
import { sendNotification } from '@/lib/notify';

const ROLES = new Set(['ADMIN', 'SITE_MANAGER', 'STANDARD']);
const parseDay = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) ? d : null;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  const groupId = vis.groupId as string;
  const siteId = vis.primarySiteId;
  if (!siteId) return res.status(400).json({ message: 'No location yet.' });
  if (!(await requireCanWrite(groupId, res))) return;

  const b = (req.body || {}) as any;
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json({ message: 'Name is required.' });
  const salary = Math.round(Number(b.salaryPounds) * 100);
  if (!Number.isFinite(salary) || salary < 0) return res.status(400).json({ message: 'Enter a valid annual salary.' });
  const isChargeable = !!b.isChargeable;
  let hours: number | null = null;
  if (b.hoursPerDay != null && b.hoursPerDay !== '') {
    const h = Number(b.hoursPerDay);
    if (!Number.isFinite(h) || h < 0 || h > 24) return res.status(400).json({ message: 'Contracted hours must be between 0 and 24.' });
    hours = h;
  }
  const workingDays: number[] = Array.isArray(b.workingDays) ? b.workingDays.map(Number).filter((d: number) => d >= 0 && d <= 6) : [];
  const startDate = b.startDate ? parseDay(b.startDate) : null;
  if (b.startDate && !startDate) return res.status(400).json({ message: 'Enter a valid start date.' });

  // Login: 'none' = payroll-only (CostPerson with no User, no invite).
  const wantsLogin = b.login && b.login !== 'none';
  const role = wantsLogin ? String(b.login) : null;
  const canInvoice = !!b.canInvoice;
  const email = String(b.email ?? '').trim().toLowerCase();
  if (wantsLogin) {
    if (!ROLES.has(role as string)) return res.status(400).json({ message: 'Pick a valid role.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'A valid email is needed to invite them.' });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ message: 'A user with this email already exists — edit them under Settings → Users.' });
  }

  const invite = wantsLogin ? makeInviteToken() : null;
  const effective = startDate ?? new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

  const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let userId: string | null = null;
    if (wantsLogin && invite) {
      const u = await tx.user.create({
        data: {
          name, email, group_id: groupId, site_id: siteId,
          role: role as any, can_invoice: role === 'STANDARD' ? canInvoice : false,
          is_active: false, // pending until they set a password via the invite link (8-char floor there)
          passwordHash: 'INVITE_PENDING', // same sentinel as /api/users — unusable until set-password
          invite_token_hash: invite.hash, invite_token_expires: invite.expires,
          invite_token_used_at: null,
        },
        select: { id: true },
      });
      await tx.userSite.create({ data: { user_id: u.id, site_id: siteId } });
      userId = u.id;
    }
    const person = await tx.costPerson.create({
      data: {
        group_id: groupId, name, role: b.jobTitle ? String(b.jobTitle).trim() : null,
        cost_type: 'salary', amount_pennies: salary, user_id: userId,
        is_chargeable: isChargeable, contracted_hours_per_day: hours == null ? null : new Prisma.Decimal(hours.toFixed(2)),
        working_days: workingDays, start_date: startDate,
        // utilisation_factor deliberately NOT collected — schema default 70 (a tuning knob for HR later)
      },
      select: { id: true },
    });
    await tx.costAllocation.create({ data: { group_id: groupId, site_id: siteId, percent: new Prisma.Decimal(100), cost_person_id: person.id } });
    await recordEmploymentEvents(tx, {
      groupId, costPersonId: person.id, changedBy: vis.userId ?? null, effectiveDate: effective,
      changes: [{ kind: 'started', value: { start_date: effective.toISOString().slice(0, 10) }, previous: null }],
    });
    return { personId: person.id, userId };
  });

  // Invite AFTER commit, through THE notification chokepoint — team_invite's first sender.
  let inviteSent = false;
  if (wantsLogin && invite) {
    const grp = await prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true } });
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com';
    const r = await sendNotification({
      recipient: email, template: 'team_invite', channel: 'email', groupId,
      data: { garageName: grp?.group_name ?? 'GreaseDesk', link: `${baseUrl}/set-password?token=${invite.raw}` },
      subject: { type: 'user', id: created.userId as string },
    });
    inviteSent = r.ok;
    if (!r.ok) console.warn('[setup-wizard] invite email not sent:', r.status);
  }

  return res.status(201).json({ id: created.personId, userId: created.userId, inviteSent, message: 'Technician added.' });
}
