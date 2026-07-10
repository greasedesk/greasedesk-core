/**
 * File: lib/payment-methods.ts
 * THE payment-methods chokepoint. getPaymentMethods lazy-seeds the sensible defaults on first
 * read (Cash = instant, Card = windowed) so every tenant — existing and future — starts with a
 * working list the admin then extends (Warranty company / EMAC = manual, …). Behaviour drives the
 * paid-state machine: instant skips the window, windowed uses the tenant's clearance window,
 * manual stays pending (confirm_due_at NULL — the cron's lte-now filter never matches it) until
 * explicitly confirmed.
 */
import { prisma } from '@/lib/db';

export type PaymentMethodLite = { id: string; name: string; behaviour: 'instant' | 'windowed' | 'manual'; active: boolean; position: number };

const DEFAULTS: Array<{ name: string; behaviour: 'instant' | 'windowed' }> = [
  { name: 'Cash', behaviour: 'instant' },
  { name: 'Card', behaviour: 'windowed' },
];

export async function getPaymentMethods(groupId: string, includeInactive = false): Promise<PaymentMethodLite[]> {
  let rows = (await prisma.paymentMethod.findMany({
    where: { group_id: groupId, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
    select: { id: true, name: true, behaviour: true, active: true, position: true },
  })) as PaymentMethodLite[];
  if (rows.length === 0) {
    const any = await prisma.paymentMethod.count({ where: { group_id: groupId } });
    if (any === 0) {
      // Lazy seed — covers existing tenants and every future one without onboarding changes.
      await prisma.paymentMethod.createMany({ data: DEFAULTS.map((d, i) => ({ group_id: groupId, name: d.name, behaviour: d.behaviour, position: i })) });
      rows = (await prisma.paymentMethod.findMany({
        where: { group_id: groupId, ...(includeInactive ? {} : { active: true }) },
        orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
        select: { id: true, name: true, behaviour: true, active: true, position: true },
      })) as PaymentMethodLite[];
    }
  }
  return rows;
}
