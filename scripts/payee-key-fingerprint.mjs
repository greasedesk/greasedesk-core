/**
 * File: scripts/payee-key-fingerprint.mjs
 * PRINT A PAYEE KEY'S FINGERPRINT. The key goes in, 16 hex comes out, and nothing is saved.
 *
 *   read -rs PAYEE_ENC_KEY && export PAYEE_ENC_KEY \
 *     && node scripts/payee-key-fingerprint.mjs > /tmp/fp.log 2>&1; unset PAYEE_ENC_KEY
 *   cat /tmp/fp.log
 *
 * `read -rs` does not echo, and the value never appears on a command line, so it is not in the
 * shell history. The OUTPUT is not a secret — it is a one-way check value — so writing it to a file
 * and pasting it into lib/payee-key-check is fine. The KEY must not be written anywhere.
 *
 * ── IT DOES NOT LOAD .env, AND THAT IS THE POINT ────────────────────────────────────────────────
 * Only lib/db loads .env in this codebase (measured), and this script does not import it or touch
 * the database at all. So the ONLY source of a key here is what you exported. Forget to export one
 * and it refuses — rather than silently fingerprinting the gate key from .env and letting you
 * register that as production's, which is the exact mistake this whole mechanism exists to stop.
 *
 * It computes through lib/payee-crypto's own function rather than reimplementing the HMAC. Two
 * implementations of a check value is two chances for the registered fingerprint to be of something
 * other than what the app will compute.
 */
import './_ts.mjs';

const { fingerprintOf, PAYEE_KEY_CHECK_LABEL, PAYEE_FINGERPRINT_HEX, PayeeKeyError } = await import('../lib/payee-crypto.ts');

const raw = (process.env.PAYEE_ENC_KEY ?? '').trim();
if (!raw) {
  console.error('\n  PAYEE_ENC_KEY is not set in this process, and this script deliberately does not read .env.');
  console.error('  Export the key you want to fingerprint, without putting it on a command line:\n');
  console.error('    read -rs PAYEE_ENC_KEY && export PAYEE_ENC_KEY \\');
  console.error('      && node scripts/payee-key-fingerprint.mjs > /tmp/fp.log 2>&1; unset PAYEE_ENC_KEY\n');
  process.exit(2);
}

try {
  const fp = fingerprintOf(raw);
  // THE KEY IS NEVER PRINTED, not even truncated: a prefix of a base64 key is a prefix of a key.
  console.log(`\n  fingerprint   ${fp}`);
  console.log(`  label         ${PAYEE_KEY_CHECK_LABEL}`);
  console.log(`  length        ${PAYEE_FINGERPRINT_HEX} hex of HMAC-SHA256(key, label)`);
  console.log('\n  This is NOT the key and is safe to paste, print and commit. Record it against the right');
  console.log('  environment in lib/payee-key-check::PAYEE_KEY_FINGERPRINTS.\n');
  process.exit(0);
} catch (e) {
  if (e instanceof PayeeKeyError) {
    console.error(`\n  ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}
