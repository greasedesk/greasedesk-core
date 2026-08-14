/**
 * File: lib/provider-connection.ts
 * THE store for a tenant's connection to a payment provider, and THE derivation of the state the
 * product renders. One row per (group, provider); one function that turns that row into a state.
 *
 * ── PROVIDER-AGNOSTIC BY CONSTRUCTION ───────────────────────────────────────────────────────────
 * This was `connectState` over eight `stripe_*` columns on Group. Nothing about the six states is
 * Stripe-specific — never connected, half set up, live, restricted, revoked, unreadable — so the
 * provider-specific code (lib/stripe-connect) now only translates its provider's objects into these
 * columns, and the page has no idea which provider it is rendering.
 *
 * ── STATE IS DERIVED, NEVER STORED ──────────────────────────────────────────────────────────────
 * A `status` column would be a seventh thing to keep in step with the provider and the first to go
 * stale. The columns are a cache of the provider's truth; the state is a pure function of them.
 */
import { prisma } from '@/lib/db';

export type ProviderKey = 'stripe' | 'payment_assist' | 'bumper';

export type ConnectionRow = {
  provider: string;
  external_id: string | null;
  livemode: boolean | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  disabled_reason: string | null;
  requirements_due: unknown;
  connected_at: Date | null;
  disconnected_at: Date | null;
};

export type ProviderState =
  /** No connection has ever been made for this tenant and provider. */
  | { status: 'not_connected' }
  /** Created, but the garage has not finished what the provider asks for. */
  | { status: 'incomplete'; externalId: string; requirementsDue: string[] }
  /** Set up and able to take payments. */
  | { status: 'ready'; externalId: string; payoutsEnabled: boolean }
  /** The provider has switched charges off — the reason is the provider's own wording. */
  | { status: 'restricted'; externalId: string; reason: string | null; requirementsDue: string[] }
  /** The garage revoked our access at the provider's end. */
  | { status: 'disconnected'; disconnectedAt: Date }
  /**
   * The stored connection cannot be read with this environment's credentials. For Stripe this is
   * overwhelmingly a MODE MISMATCH — a sandbox account being read by the live deployment, or the
   * reverse — which Stripe reports as a bare "no such account" that means nothing to a garage.
   */
  | { status: 'unreachable'; externalId: string; livemode: boolean | null; reason: string };

const dueList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** The ONE place a stored row becomes a state the UI can switch on. Pure, so the gate can assert it. */
export function providerState(row: ConnectionRow | null | undefined): ProviderState {
  if (!row?.external_id) {
    return row?.disconnected_at ? { status: 'disconnected', disconnectedAt: row.disconnected_at } : { status: 'not_connected' };
  }
  const due = dueList(row.requirements_due);
  if (row.charges_enabled) return { status: 'ready', externalId: row.external_id, payoutsEnabled: row.payouts_enabled };
  // Charges off WITH a reason is a restriction; charges off with no reason is simply a setup that
  // was started and not finished. Different sentences, different remedies.
  if (row.disabled_reason) {
    return { status: 'restricted', externalId: row.external_id, reason: row.disabled_reason, requirementsDue: due };
  }
  return { status: 'incomplete', externalId: row.external_id, requirementsDue: due };
}

const SELECT = {
  provider: true, external_id: true, livemode: true, charges_enabled: true, payouts_enabled: true,
  disabled_reason: true, requirements_due: true, connected_at: true, disconnected_at: true,
} as const;

export async function readConnection(groupId: string, provider: ProviderKey): Promise<ConnectionRow | null> {
  return (await (prisma as any).providerConnection.findUnique({
    where: { group_id_provider: { group_id: groupId, provider } },
    select: SELECT,
  })) as ConnectionRow | null;
}

/** Every connection this tenant holds, keyed by provider — one query for a page listing all of them. */
export async function readConnections(groupId: string): Promise<Record<string, ConnectionRow>> {
  const rows = (await (prisma as any).providerConnection.findMany({ where: { group_id: groupId }, select: SELECT })) as ConnectionRow[];
  return Object.fromEntries(rows.map((r) => [r.provider, r]));
}

export type ConnectionPatch = Partial<Omit<ConnectionRow, 'provider'>>;

/**
 * THE writer. Upsert because the row may not exist yet — a tenant only gets one at the moment they
 * first connect, since 'not_connected' is the absence of a connection rather than a stored status.
 */
export async function writeConnection(groupId: string, provider: ProviderKey, patch: ConnectionPatch): Promise<ConnectionRow> {
  const data: any = { ...patch };
  return (await (prisma as any).providerConnection.upsert({
    where: { group_id_provider: { group_id: groupId, provider } },
    create: { group_id: groupId, provider, ...data },
    update: data,
    select: SELECT,
  })) as ConnectionRow;
}

/**
 * The garage revoked us. The external id is CLEARED — it is no longer ours to use — but
 * `disconnected_at` is kept so the product can say what happened instead of silently reverting to
 * "never connected", which is a different and misleading state.
 *
 * Resolved by external id because a revocation arrives naming the provider's account, not our tenant.
 */
export async function clearConnection(provider: ProviderKey, externalId: string): Promise<void> {
  await (prisma as any).providerConnection.updateMany({
    where: { provider, external_id: externalId },
    data: {
      external_id: null,
      charges_enabled: false,
      payouts_enabled: false,
      disabled_reason: null,
      requirements_due: undefined,
      disconnected_at: new Date(),
    },
  });
}
