/**
 * File: lib/hr-personal.ts
 * The optional personal block on an employee record — one place for what the fields ARE, so the
 * form, the API and the gate cannot drift on which are optional (all of them) or what null means.
 *
 * ── NOTHING IS MANDATORY, AND NOTHING DEFAULTS ──────────────────────────────────────────────────
 * Every field is nullable and every one may stay that way forever. Null means NOT ASKED / NOT
 * ANSWERED and must never be rendered as a value — an empty label is worse than an absent one,
 * because it reads as "we asked and they had none".
 *
 * ── GENDER AND PRONOUNS ─────────────────────────────────────────────────────────────────────────
 * Article 9(1) UK GDPR does not list gender identity, so neither field is special category data on
 * its own. But an "other"/"prefer not to say" selection, or pronouns that do not match the gender
 * field, can REVEAL gender reassignment and therefore health — which is Article 9. So they are
 * treated as if they were: unselected by default, explained where they are entered, never inferred
 * from a name, and never required. "Prefer not to say" is stored as its own value rather than as
 * null, so that a deliberate refusal is distinguishable from never having been asked.
 */

export const GENDER_OPTIONS = ['male', 'female', 'other', 'prefer_not_to_say'] as const;
export type Gender = (typeof GENDER_OPTIONS)[number];
export const isGender = (v: unknown): v is Gender =>
  typeof v === 'string' && (GENDER_OPTIONS as readonly string[]).includes(v);

export const GENDER_LABELS: Record<Gender, string> = {
  male: 'Male', female: 'Female', other: 'Other', prefer_not_to_say: 'Prefer not to say',
};

/** The personal block as the API accepts and returns it. Every key optional, every value nullable. */
export type PersonalDetails = {
  dateOfBirth: string | null;   // yyyy-mm-dd
  homeAddress: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  emergencyContactName: string | null;
  emergencyContactRelationship: string | null;
  emergencyContactPhone: string | null;
  gender: Gender | null;
  pronouns: string | null;
};

const text = (v: unknown, max = 200): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;   // blank → null, so clearing a field genuinely clears it
};
const day = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Normalise whatever the form sent. Never throws — an unusable value becomes null rather than
 *  blocking a save, because none of this is required and a bad DOB must not stop someone recording
 *  an emergency contact. The one exception that IS reported is a malformed date the user typed. */
export function readPersonalDetails(body: Record<string, unknown>): PersonalDetails {
  return {
    dateOfBirth: day(body.dateOfBirth),
    homeAddress: text(body.homeAddress, 500),
    personalEmail: text(body.personalEmail),
    personalPhone: text(body.personalPhone, 40),
    emergencyContactName: text(body.emergencyContactName),
    emergencyContactRelationship: text(body.emergencyContactRelationship, 60),
    emergencyContactPhone: text(body.emergencyContactPhone, 40),
    gender: isGender(body.gender) ? body.gender : null,
    pronouns: text(body.pronouns, 40),
  };
}

/** Column names, so the API writes and reads the same set. */
export const toColumns = (d: PersonalDetails) => ({
  date_of_birth: d.dateOfBirth ? new Date(`${d.dateOfBirth}T00:00:00.000Z`) : null,
  home_address: d.homeAddress,
  personal_email: d.personalEmail,
  personal_phone: d.personalPhone,
  emergency_contact_name: d.emergencyContactName,
  emergency_contact_relationship: d.emergencyContactRelationship,
  emergency_contact_phone: d.emergencyContactPhone,
  gender: d.gender,
  pronouns: d.pronouns,
});

export const fromColumns = (r: any): PersonalDetails => ({
  dateOfBirth: r?.date_of_birth ? new Date(r.date_of_birth).toISOString().slice(0, 10) : null,
  homeAddress: r?.home_address ?? null,
  personalEmail: r?.personal_email ?? null,
  personalPhone: r?.personal_phone ?? null,
  emergencyContactName: r?.emergency_contact_name ?? null,
  emergencyContactRelationship: r?.emergency_contact_relationship ?? null,
  emergencyContactPhone: r?.emergency_contact_phone ?? null,
  gender: isGender(r?.gender) ? r.gender : null,
  pronouns: r?.pronouns ?? null,
});

/** TRUE when the person has none of it recorded — the screen renders a single line rather than a
 *  column of empty labels, which would read as "asked and answered blank". */
export const personalDetailsEmpty = (d: PersonalDetails): boolean =>
  Object.values(d).every((v) => v === null);
