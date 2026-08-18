/**
 * File: lib/demo/demo-subject.ts
 * THE ONE DEMO CUSTOMER WHOSE PHONE IS REAL.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
 * Every generated customer sits on Ofcom's reserved drama range (07700 900xxx), which is allocated
 * to nobody. That is deliberate: seeded rows can never text a stranger even on a tenant whose sends
 * are not blocked. It also means a demo text is accepted and then goes nowhere — and whether the
 * provider refuses it outright or accepts it and fails at the carrier decides whether the operator
 * finds out at the moment it matters or only later in the Messages thread. During a live demo
 * nobody is watching Messages.
 *
 * So ONE row carries a real, owner-supplied number. The demo has a subject that actually receives.
 *
 * ── WHY IT IS A GENERATION INPUT AND NOT A MANUAL EDIT ──────────────────────────────────────────
 * The refresh model is REGENERATE, not shift. A row edited by hand after generation is destroyed by
 * the next refresh, silently, and the demo fails in front of a prospect with nobody knowing why.
 * The same defect as the hardcoded town: a fact living somewhere the regeneration does not know
 * about. It is passed in, so every generation reproduces it.
 *
 * ── THE GUARD ───────────────────────────────────────────────────────────────────────────────────
 * A real number in seeded data is only safe while the tenant is a declared internal demo. This
 * refuses anything else, checked against the database at the moment of use — the same two
 * conditions lib/demo-tenants::refuseRefresh uses, for the same reason.
 */
import { customerPhoneFields } from '@/lib/contact-routes';
import { resolveTenantProfile } from '@/lib/locale-profiles';

/** GB dial code from the country profile. The second argument is a DIAL CODE ('44'), never 'GB'. */
const GB_DIAL = resolveTenantProfile({ country_code: 'GB' }).dialCode;

export type DemoSubject = {
  /** The name the rep will look for in the customer list. */
  name: string;
  /** A REAL number, in national form. The only one in the tenant that is not on the drama range. */
  phone: string;
};

export type SubjectRefusal = { code: string; message: string };

/**
 * PURE, so the refusal is provable without writing a real number to anything — the standing rule
 * that a guard is proven against the predicate, never against the live path it protects.
 *
 * `group` is what the database says NOW; `listed` is the declared-target check from lib/demo-tenants.
 */
export function refuseDemoSubject(
  groupId: string,
  listed: boolean,
  group: { ref: string | null; is_internal: boolean | null } | null,
  subject: DemoSubject,
): SubjectRefusal | null {
  if (!listed) {
    return {
      code: 'not_listed',
      message: `${groupId} is not a declared demo tenant. A real phone number is only ever seeded into `
        + `a tenant listed in lib/demo-tenants::DEMO_TENANTS.`,
    };
  }
  if (!group) return { code: 'not_found', message: `${groupId} does not exist.` };
  if (group.is_internal !== true) {
    return {
      code: 'not_internal',
      message: `${group.ref ?? groupId} is listed but is NOT is_internal. Refusing to seed a real `
        + `number into it — check the tenant before the list.`,
    };
  }
  if (!subject.name.trim()) return { code: 'no_name', message: 'The demo subject needs a name to find it by.' };
  const e164 = customerPhoneFields(subject.phone, GB_DIAL).phone_e164;
  if (!e164) {
    return { code: 'unusable_number', message: `"${subject.phone}" does not normalise to a dialable GB number.` };
  }
  // THE WHOLE POINT is that this one is real. A drama-range number here would be the bug it exists
  // to fix, arriving disguised as a fix.
  if (/^447700900/.test(e164)) {
    return {
      code: 'reserved_range',
      message: `${subject.phone} is on Ofcom's reserved drama range, which reaches nobody. The demo `
        + `subject exists precisely to be reachable — use a real number.`,
    };
  }
  return null;
}

/**
 * The normalised columns to write. Separated so the caller does the writing and this stays pure.
 *
 * THROWS on an unnormalisable number rather than writing NULL. refuseDemoSubject has already
 * rejected that case; reaching here with one means the caller skipped the guard, and a demo subject
 * silently landing with no dialable number is the exact failure this module exists to prevent.
 */
export function demoSubjectColumns(subject: DemoSubject): { name: string; phone: string; phone_e164: string } {
  const e164 = customerPhoneFields(subject.phone, GB_DIAL).phone_e164;
  if (!e164) throw new Error(`DEMO_SUBJECT_UNUSABLE_NUMBER: "${subject.phone}" — call refuseDemoSubject first.`);
  return { name: subject.name.trim(), phone: subject.phone.trim(), phone_e164: e164 };
}
