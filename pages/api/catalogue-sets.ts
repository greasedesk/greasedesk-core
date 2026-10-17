/**
 * File: pages/api/catalogue-sets.ts
 * NAMED SETS OF CATALOGUE ITEMS. ADMIN/owner only (requireAdminApi); tenant-scoped throughout.
 *
 *   GET                 every set with its members, in set order then member order
 *   POST   { name, shape }                           create
 *   PATCH  { id, name?, shape?, active?, members? }   rename, re-shape, archive, set membership
 *   DELETE ?id=                                       remove the set (memberships cascade)
 *
 * ── MEMBERSHIP IS SENT WHOLE, AND RECONCILED IN PLACE ──────────────────────────────────────────
 * `members` is the complete list for the set, the same contract the estimate's lines use. It is
 * reconciled rather than deleted-and-recreated: a membership id that survives is a membership a
 * future join can point at, and the quote endpoint has already paid for learning that lesson once.
 *
 * ── THE LADDER RULE IS REFUSED IN WORDS HERE AND GUARANTEED IN THE DATABASE ────────────────────
 * lib/catalogue-sets::refuseMembership turns "already in another ladder" into a sentence before
 * the write happens. It is NOT the guarantee — two writers racing would both pass it — and the
 * deferred constraint trigger behind it is. A 23505 coming back from the database is translated
 * rather than leaked, because the trigger's message is for a developer and this one is for a
 * garage owner looking at a screen.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { refuseSet, refuseMembership, isGroupShape, type SetShape } from '@/lib/catalogue-sets';
import { writeAudit } from '@/lib/audit';

// NOT `as const` on the whole literal: Prisma's orderBy wants a MUTABLE array, and a readonly
// tuple is rejected at the call site rather than where it was written.
const SET_SELECT = {
  id: true, name: true, shape: true, position: true, active: true,
  members: {
    select: { id: true, catalogue_item_id: true, position: true },
    // Position, then id — a TOTAL order, so two members sharing a position do not come back in
    // whatever order Postgres felt like, which is how a ladder silently reorders between reads.
    orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }],
  },
};

const shaped = (s: any) => ({
  id: s.id, name: s.name, shape: s.shape as SetShape, position: s.position, active: s.active,
  members: s.members.map((m: any) => ({ id: m.id, catalogueItemId: m.catalogue_item_id, position: m.position })),
});

/** The database's one-ladder trigger speaks in SQLSTATE. A garage owner should not have to. */
const LADDER_CLASH = 'This product is already a choice in another set of alternatives. An item can sit in one ladder, because dropping the ladder icon has to know which one to offer.';
const isLadderClash = (e: unknown): boolean => {
  const m = String((e as { message?: unknown })?.message ?? '');
  return m.includes('more than one pick_one set') || m.includes('23505');
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId as string;

  if (req.method === 'GET') {
    const sets = await prisma.catalogueSet.findMany({
      where: { group_id: groupId }, select: SET_SELECT, orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return res.status(200).json({ sets: sets.map(shaped) });
  }

  if (req.method === 'POST') {
    const refusal = refuseSet({ name: req.body?.name, shape: req.body?.shape });
    if (refusal) return res.status(400).json({ code: refusal.code, message: refusal.message });
    const name = String(req.body.name).trim();
    const exists = await prisma.catalogueSet.count({ where: { group_id: groupId, name } });
    if (exists) return res.status(409).json({ code: 'name_taken', message: `There is already a set called “${name}”.` });
    const position = await prisma.catalogueSet.count({ where: { group_id: groupId } });
    const made = await prisma.catalogueSet.create({
      data: { group_id: groupId, name, shape: String(req.body.shape), position },
      select: SET_SELECT,
    });
    await writeAudit(prisma, { groupId, userId: vis.userId ?? null, entity: 'catalogue_set', entityId: made.id,
      action: 'catalogue_set.created', diff: { name, shape: String(req.body.shape) } }).catch(() => {});
    return res.status(200).json({ set: shaped(made) });
  }

  if (req.method === 'PATCH') {
    const id = String(req.body?.id ?? '');
    // SCOPED READ FIRST. The id is a claim; a set from another tenant must read as absent, never
    // as something this request may write to.
    const own = await prisma.catalogueSet.findFirst({ where: { id, group_id: groupId }, select: { id: true, name: true, shape: true } });
    if (!own) return res.status(404).json({ message: 'That set no longer exists.' });

    const name = req.body?.name === undefined ? own.name : String(req.body.name).trim();
    const shape = req.body?.shape === undefined ? own.shape : String(req.body.shape);
    const refusal = refuseSet({ name, shape });
    if (refusal) return res.status(400).json({ code: refusal.code, message: refusal.message });
    if (name !== own.name && (await prisma.catalogueSet.count({ where: { group_id: groupId, name } }))) {
      return res.status(409).json({ code: 'name_taken', message: `There is already a set called “${name}”.` });
    }

    // MEMBERS, when sent. Every catalogue id is intersected with THIS tenant's catalogue, so a
    // foreign id is structurally unable to be written rather than caught by a check.
    let members: Array<{ catalogueItemId: string; position: number }> | null = null;
    if (Array.isArray(req.body?.members)) {
      const claimed = req.body.members.map((m: any) => String(m?.catalogueItemId ?? '')).filter(Boolean);
      const mine = new Set((await prisma.catalogueItem.findMany({
        where: { id: { in: claimed }, group_id: groupId }, select: { id: true },
      })).map((r) => r.id));
      // Built as a const FIRST and assigned second. Reading back out of the nullable `let` is
      // what made the compiler ask, twice, whether this could be null — and a `!` to silence it
      // would be a place the compiler stops checking, in the branch that decides membership.
      const wanted: Array<{ catalogueItemId: string; position: number }> = req.body.members
        .map((m: any, i: number) => ({ catalogueItemId: String(m?.catalogueItemId ?? ''), position: Number.isFinite(Number(m?.position)) ? Number(m.position) : i }))
        .filter((m: { catalogueItemId: string }) => mine.has(m.catalogueItemId));
      members = wanted;
      if (isGroupShape(shape) && shape === 'pick_one') {
        // THE READABLE REFUSAL, before the trigger's. Named sets, so the message can say which.
        const others = await prisma.catalogueSetMember.findMany({
          where: {
            group_id: groupId,
            catalogue_item_id: { in: wanted.map((m) => m.catalogueItemId) },
            set: { shape: 'pick_one', id: { not: id } },
          },
          select: { set: { select: { name: true } } },
        });
        const clash = refuseMembership({ shape: 'pick_one', otherLadderNames: others.map((o) => o.set.name) });
        if (clash) return res.status(409).json({ code: clash.code, message: clash.message });
      }
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        await tx.catalogueSet.update({ where: { id }, data: { name, shape, ...(req.body?.active === undefined ? {} : { active: !!req.body.active }) } });
        if (members) {
          const rows = members; // narrowed once — `members` is nullable and this block is its only reader
          const keep = new Set(rows.map((m) => m.catalogueItemId));
          await tx.catalogueSetMember.deleteMany({ where: { set_id: id, catalogue_item_id: { notIn: [...keep] } } });
          for (const m of rows) {
            // IN PLACE: update the row that exists, create the one that does not. Never
            // delete-and-recreate — see pages/api/jobcard-quote for what that costs.
            const have = await tx.catalogueSetMember.findFirst({ where: { set_id: id, catalogue_item_id: m.catalogueItemId }, select: { id: true } });
            if (have) await tx.catalogueSetMember.update({ where: { id: have.id }, data: { position: m.position } });
            else await tx.catalogueSetMember.create({ data: { group_id: groupId, set_id: id, catalogue_item_id: m.catalogueItemId, position: m.position } });
          }
        }
        return tx.catalogueSet.findFirstOrThrow({ where: { id }, select: SET_SELECT });
      });
      await writeAudit(prisma, { groupId, userId: vis.userId ?? null, entity: 'catalogue_set', entityId: id,
        action: 'catalogue_set.updated', diff: { name, shape, members: members?.length ?? null } }).catch(() => {});
      return res.status(200).json({ set: shaped(updated) });
    } catch (e) {
      if (isLadderClash(e)) return res.status(409).json({ code: 'already_in_a_ladder', message: LADDER_CLASH });
      throw e;
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query?.id ?? '');
    const own = await prisma.catalogueSet.findFirst({ where: { id, group_id: groupId }, select: { id: true, name: true } });
    if (!own) return res.status(404).json({ message: 'That set no longer exists.' });
    // The memberships go with it (FK cascade). The PRODUCTS do not: a set is a grouping, and
    // removing it says nothing about whether the garage still sells the things that were in it.
    await prisma.catalogueSet.delete({ where: { id } });
    await writeAudit(prisma, { groupId, userId: vis.userId ?? null, entity: 'catalogue_set', entityId: id,
      action: 'catalogue_set.deleted', diff: { name: own.name } }).catch(() => {});
    return res.status(200).json({ deleted: true });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
