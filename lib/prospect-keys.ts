/**
 * File: lib/prospect-keys.ts
 * THE TWO VALUES A PROSPECT NEEDS FROM `crypto` — server-only, and split from lib/prospects on purpose.
 *
 * lib/prospects is imported by the rep's pages for its labels, and a page with no getServerSideProps
 * ships WHOLE to the phone. Node's `crypto` has no place in that bundle, and client-bundle-gate would
 * not have caught it: it looks for paths to lib/db, not for Node built-ins. So the hashing lives here,
 * where only server code reaches it, and lib/prospects imports nothing at all.
 */
import { createHash, randomBytes } from 'crypto';
import { normaliseEmail } from '@/lib/prospects';

/** sha256 of the normalised address — what survives an unsubscribe once the address is gone. */
export function emailHash(e: string): string {
  return createHash('sha256').update(normaliseEmail(e) ?? '').digest('hex');
}

/** 16 random bytes, base64url — 22 characters; Prospect_token_shape_chk holds the shape. */
export const newUnsubscribeToken = (): string => randomBytes(16).toString('base64url');
