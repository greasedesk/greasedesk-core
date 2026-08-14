/**
 * File: lib/payment-providers.ts
 * THE catalogue of payment providers a garage can connect. Product vocabulary only — the stored row
 * and its state live in lib/provider-connection, and each provider's own API lives in its own file.
 *
 * ── A REGISTRY SO THE SECOND PROVIDER IS A ROW, NOT A REBUILD ───────────────────────────────────
 * Payment Assist and Bumper are both coming, and both are per-dealer credentialed rather than
 * OAuth-style: the garage already holds an account and hands us credentials. That is a genuinely
 * different connection gesture from Stripe's, which is why `connection` exists — but it is the ONLY
 * difference the page can see. Everything else (the six states, the wording, the layout) is shared,
 * so /admin/payments contains no provider name and no `if (stripe)`.
 *
 * WHAT A CREDENTIALS PROVIDER WILL ADD, when it comes:
 *   - `connection: 'credentials'`, which makes the row's action open a form instead of a redirect
 *   - somewhere to put the secret, which is a real decision and NOT this table's job — an encrypted
 *     store is a new class of data in the product and changes what a database dump means
 *   - a translator from its API into ProviderConnection's columns, the job lib/stripe-connect does
 * No change to this file's shape, the page, or the store.
 *
 * ── ONLY WHAT IS SHIPPED GETS LISTED ────────────────────────────────────────────────────────────
 * There is no 'coming soon' row. A garage that reads one asks when, and the honest answer is that
 * we don't know — so the registry holds providers a garage can actually connect today, and gains an
 * entry the day one becomes real.
 */
import type { ProviderKey } from '@/lib/provider-connection';

/**
 * A surface a provider can render inside our page, rather than sending the garage to its dashboard.
 * `mayAuthenticate` is not decoration: Stripe requires its own sign-in for some embedded components
 * on the account type we chose, and a popup nobody warned about reads as a phishing attempt.
 */
export type PanelKey = 'payments' | 'payouts' | 'account';
export type ProviderPanel = { key: PanelKey; label: string; mayAuthenticate: boolean };

export type ProviderDef = {
  key: ProviderKey;
  name: string;
  /** One line under the name, true in every state. */
  tagline: string;
  /** The pitch. Shown only when there is nothing connected — nobody needs selling to twice. */
  blurb: string;
  /**
   * How a garage connects. 'oauth_redirect' sends them to the provider and back; 'credentials' means
   * they already hold an account and give us the details.
   */
  connection: 'oauth_redirect' | 'credentials';
  /** The endpoint that starts or continues a connection. */
  connectPath: string;
  /** Panels this provider can render in-page, in tab order. Empty = state and actions only. */
  panels: ProviderPanel[];
};

export const PROVIDERS: ProviderDef[] = [
  {
    key: 'stripe',
    name: 'Stripe',
    tagline: 'Card payments, paid out to your own bank account',
    blurb:
      'Connect a Stripe account so customers can pay their invoice by card. You keep your own Stripe account and your own money; we never hold it.',
    connection: 'oauth_redirect',
    connectPath: '/api/stripe/connect',
    panels: [
      // Payments and payout history are readable without Stripe asking the garage to sign in.
      { key: 'payments', label: 'Payments', mayAuthenticate: false },
      { key: 'payouts', label: 'Payouts', mayAuthenticate: false },
      // Account details cannot be: changing bank or business details is Stripe's to authorise, and
      // on a Standard account there is no way to turn that off that we are willing to take.
      { key: 'account', label: 'Account details', mayAuthenticate: true },
    ],
  },
];

export const providerDef = (key: string): ProviderDef | undefined => PROVIDERS.find((p) => p.key === key);
