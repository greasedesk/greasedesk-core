/**
 * File: lib/stripe-errors.ts
 * THE translator from a thrown Stripe error into something both a garage owner and a log can use.
 *
 * ── THE FAILURE THIS EXISTS TO STOP ─────────────────────────────────────────────────────────────
 * Every error from the Stripe SDK used to collapse into one 502 saying "Stripe couldn't be reached.
 * Please try again." A rejected key, a key without Connect permission, Connect not being enabled for
 * live, a rate limit and an actual network failure all read identically — and for four of those five
 * the sentence is FALSE: the request reached Stripe and Stripe answered. Worse, "please try again"
 * invited a retry that could not possibly work, and on the connect path every retry re-enters
 * accounts.create.
 *
 * ── RETRYABLE IS THE AXIS THAT MATTERS ──────────────────────────────────────────────────────────
 * Not severity, not whose fault it is: whether doing the same thing again could produce a different
 * answer. Connection and API failures are transient, so they keep 502 and "please try again". A
 * permission or capability refusal is SETTLED — it will fail identically every time until somebody
 * changes a key scope or Stripe approves something — so it returns 409 and says so plainly.
 *
 * ── CLASSIFY ON `type`, THE STRING, NOT ON `instanceof` ─────────────────────────────────────────
 * The SDK sets `error.type` to its own class name (verified: StripePermissionError, StripeRateLimit-
 * Error and so on). Reading the string rather than using instanceof survives two copies of the
 * package and an error that has been re-thrown or serialised — and, more usefully, it makes this a
 * pure function over a plain object, so the gate can assert every branch with no network and no SDK.
 *
 * ── STRIPE'S OWN MESSAGE IS CARRIED, NEVER PARAPHRASED ──────────────────────────────────────────
 * The same discipline as `disabled_reason`. Our sentence says what it means for the garage; Stripe's
 * says what actually happened, verbatim, alongside it. These surfaces are ADMIN-ONLY, which is what
 * makes it right to show a developer-grade detail line and a request id here — quoting that id is
 * the first thing Stripe support asks for, and the point of this work is that nobody should have to
 * open the Stripe dashboard to find out what broke.
 */

export type StripeFailureCode =
  /** 401 — Stripe rejected our credentials outright. Our fault, and settled. */
  | 'key_rejected'
  /** 403 — the key is valid but not permitted to do this. Our fault, and settled. */
  | 'key_not_permitted'
  /** 400/404 — Stripe understood us and refused. Includes "Connect isn't enabled for this platform". */
  | 'refused_by_stripe'
  /** 429 — too many requests. Genuinely retryable, but not now. */
  | 'rate_limited'
  /** No response at all: DNS, TLS, socket. The ONLY case the old sentence was true of. */
  | 'unreachable'
  /** 5xx from Stripe. Their end, transient. */
  | 'stripe_error'
  /** Not a Stripe error at all — our own bug, a Prisma failure, anything. */
  | 'unknown';

export type StripeFailure = {
  code: StripeFailureCode;
  /** What the endpoint should return. */
  status: number;
  /** Could doing exactly this again produce a different answer? Decides whether we say "try again". */
  retryable: boolean;
  /** Our sentence, for the person reading the screen. */
  message: string;
  /** Stripe's own words, verbatim. NULL unless Stripe actually answered — a connection failure has
   *  no message from Stripe, only from the socket, and presenting that as Stripe speaking is a lie. */
  stripeMessage: string | null;
  /** For quoting to Stripe support. NULL when no request completed. */
  requestId: string | null;
  /** Stripe's own doc link, when it gave one. */
  docUrl: string | null;
};

type Raw = {
  type?: unknown; rawType?: unknown; code?: unknown; statusCode?: unknown;
  requestId?: unknown; doc_url?: unknown; message?: unknown;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * ── THE SENTENCE MUST NOT PROMISE WHAT MAY NOT BE THERE ─────────────────────────────────────────
 * These read "please get in touch", NOT "quote the reference below". Stripe rejects a bad key at
 * its edge and returns no request id at all, so the reference line does not render — and a sentence
 * pointing at a line that isn't there is the same species of defect as the blanket 502. The
 * reference is shown when it exists; the copy never depends on it. Caught by rendering it.
 */
/**
 * The class → treatment table. Anything Stripe-shaped that isn't listed falls to `refused_by_stripe`
 * — NOT to a retryable default. Defaulting an unrecognised refusal to "try again" is the exact bug
 * this file replaces, and a new SDK error class arriving should inherit the safe reading: Stripe
 * answered, Stripe said no, retrying won't help, here is what it said.
 */
const TABLE: Record<string, { code: StripeFailureCode; status: number; retryable: boolean; message: string }> = {
  StripeAuthenticationError: {
    code: 'key_rejected', status: 409, retryable: false,
    message: 'Stripe rejected our credentials, so this can’t go ahead. That’s a fault at our end, not yours — please get in touch.',
  },
  StripePermissionError: {
    code: 'key_not_permitted', status: 409, retryable: false,
    message: 'Our Stripe credentials aren’t allowed to do this. That’s a fault at our end, not yours — please get in touch.',
  },
  StripeInvalidRequestError: {
    code: 'refused_by_stripe', status: 409, retryable: false,
    message: 'Stripe refused this request. Trying again won’t change the answer — what Stripe said is below.',
  },
  StripeIdempotencyError: {
    code: 'refused_by_stripe', status: 409, retryable: false,
    message: 'Stripe refused this request. Trying again won’t change the answer — what Stripe said is below.',
  },
  StripeRateLimitError: {
    code: 'rate_limited', status: 429, retryable: true,
    message: 'Stripe is handling too many requests just now. Wait a moment and try again.',
  },
  StripeConnectionError: {
    code: 'unreachable', status: 502, retryable: true,
    message: 'Stripe couldn’t be reached. Please try again.',
  },
  StripeAPIError: {
    code: 'stripe_error', status: 502, retryable: true,
    message: 'Stripe had a problem at their end. Please try again shortly.',
  },
};

const UNKNOWN: StripeFailure = {
  code: 'unknown', status: 500, retryable: false,
  message: 'Something went wrong setting this up. Please get in touch — the details are in our logs.',
  stripeMessage: null, requestId: null, docUrl: null,
};

/** Is this a Stripe SDK error? Duck-typed on the two fields the SDK always sets. */
const looksStripe = (e: Raw): boolean => typeof e?.type === 'string' && String(e.type).startsWith('Stripe');

/** THE classification. Pure, so the gate asserts the real rule rather than a copy of it. */
export function classifyStripeError(e: unknown): StripeFailure {
  const raw = (e ?? {}) as Raw;
  if (!looksStripe(raw)) return UNKNOWN;
  const t = TABLE[String(raw.type)] ?? TABLE.StripeInvalidRequestError;
  // ── "Stripe said X" IS ONLY TRUE IF STRIPE ANSWERED ──────────────────────────────────────────
  // A StripeConnectionError still carries a `message` — but it is the SOCKET's ('socket hang up'),
  // not Stripe's, and attributing it to Stripe on screen would be the same class of lie as the
  // blanket 502 this file replaces. A response implies a status code, so that is the test. The
  // gate caught this: the doc comment above already said it and the code did the opposite.
  // The raw message is still LOGGED — it is the useful part of a transport failure — just never
  // quoted to a garage owner as Stripe's words.
  const answered = num(raw.statusCode) !== null;
  return {
    ...t,
    stripeMessage: answered ? str(raw.message) : null,
    requestId: str(raw.requestId),
    docUrl: str(raw.doc_url),
  };
}

/**
 * The fields a log line needs to answer "what actually failed" without anyone opening the Stripe
 * dashboard. Every one is honest-null: a connection failure genuinely has no status and no request
 * id, and rendering those as 0 or "" would be inventing a response that never arrived.
 */
export function stripeErrorFields(e: unknown) {
  const raw = (e ?? {}) as Raw;
  return {
    type: str(raw.type),
    rawType: str(raw.rawType),
    code: str(raw.code),
    statusCode: num(raw.statusCode),
    requestId: str(raw.requestId),
    docUrl: str(raw.doc_url),
    message: str(raw.message),
  };
}

const show = (v: string | number | null) => (v === null ? '—' : String(v));

/**
 * Log the failure and return its classification, so no call site can do one without the other.
 * `scope` names the operation, not the endpoint — 'accounts.create' tells you where it broke;
 * '/api/stripe/connect' only tells you which door it came through.
 */
export function logStripeFailure(scope: string, e: unknown): StripeFailure {
  const f = stripeErrorFields(e);
  const c = classifyStripeError(e);
  console.error(
    `[stripe] ${scope} failed as ${c.code}`,
    `type=${show(f.type)}`,
    `rawType=${show(f.rawType)}`,
    `code=${show(f.code)}`,
    `status=${show(f.statusCode)}`,
    `request=${show(f.requestId)}`,
    `doc=${show(f.docUrl)}`,
    `retryable=${c.retryable}`,
    `msg=${JSON.stringify(f.message ?? (e as any)?.message ?? null)}`,
  );
  return c;
}

/** The JSON body for a refusal. Kept here so every endpoint answers in the same shape. */
export const stripeFailureBody = (f: StripeFailure) => ({
  code: f.code,
  message: f.message,
  stripeMessage: f.stripeMessage,
  requestId: f.requestId,
  docUrl: f.docUrl,
  retryable: f.retryable,
});
