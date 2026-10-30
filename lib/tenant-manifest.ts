/**
 * File: lib/tenant-manifest.ts
 *
 * WHAT A TENANT'S DATA IS — every model classified, checked against the schema at boot.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * A per-tenant export written as `where: { group_id }` does NOT see every model. The rest have no
 * group_id at all: most are reachable only through a parent (an InvoiceLine via its Invoice, a
 * VehicleOwnership via its Vehicle), a handful are keyed on a user SUBJECT with no join to a tenant
 * anywhere (TwoFactorSecret by subject_id, VerificationToken whose `identifier` IS the email), and
 * the rest are ours, not theirs.
 *
 * The purge sweep solved the same problem in August 2026 and enumerated it by hand against the 73
 * models there were then. By the time this file was written that list had decayed by 44 models
 * without anyone noticing, which is the argument for this file: not that the classification is
 * hard, but that it is only ever right on the day it is written. An export built on a stale list
 * is correct when it ships and silently incomplete afterwards, and nobody finds out until a garage
 * needs the data.
 *
 * So the invariants below are the point of the module, not a safety rail on it. The NEXT model
 * added to the schema fails the build instead of being quietly left out of every export from that
 * day on.
 *
 * NO LIVE COUNT APPEARS IN THIS COMMENT, deliberately. Counts are derived in `MANIFEST_CENSUS`
 * below, from the datamodel the invariant itself reads. A number written into prose has no reader
 * to keep it honest: this paragraph used to carry four of them and three had already decayed
 * (68 of 117, and "Model 118 fails the build", when the schema had reached 121) — the exact rot
 * the paragraph is describing, in the paragraph describing it. Fixed 2026-10-13.
 *
 * ── TWO QUESTIONS, NOT ONE ──────────────────────────────────────────────────────────────────────
 * `reach` answers "can a query find this tenant's rows", and `take` answers "may it leave the
 * building". They are independent and they disagree often: `Account` holds a user's OAuth tokens
 * and is perfectly reachable through User, and must never be exported. A single "is this tenant
 * data?" flag would have been wrong for every credential table in here.
 *
 * ── `take` IS A LEGAL QUESTION, AND THE SCREEN COPY DEPENDS ON IT ──────────────────────────────
 * A garage leaving with its data is NOT exercising portability under Article 20. Article 20 runs
 * between a controller and a data subject; a garage is the CONTROLLER of its customers' records and
 * we are its PROCESSOR. What they are owed is a processor obligation under our contract with them.
 *
 * That changes what we may refuse. A portability request can be weighed against the rights of
 * others and can be declined in parts; a processor returning a controller's own data has no such
 * latitude, and the timescale is the contract's, not the regulation's. So the screen must not say
 * "data portability", must not cite Article 20, and must not offer a right we are not the ones
 * granting. Erasure is the mirror image: we delete on the controller's instruction, except where we
 * have our own obligation to keep something — VAT records, and the commission entries that are our
 * accounts payable, which is why they are omitted above rather than exported.
 *
 * Owner's correction, 2026-10-11, recorded here because this is where the next person writing that
 * copy will look.
 *
 * ── WHAT THIS FILE CANNOT CHECK ─────────────────────────────────────────────────────────────────
 * Every `take` is a judgement. Nothing below can tell you that CommissionEntry should be omitted —
 * flipping it to 'export' breaks no invariant. What IS checked is that every model has a decision,
 * that the decision is reachable, that an omission says why, and that nothing credential-shaped or
 * byte-backed leaves without being named. The judgements themselves are reviewed by reading them.
 *
 * ── NOT A CLIENT MODULE ─────────────────────────────────────────────────────────────────────────
 * This reads Prisma's DMMF, so importing it from a component ships the client to the browser.
 * Anything the screen needs belongs in a leaf module of literals.
 */
import { Prisma } from '@prisma/client';

/** HOW a tenant's rows are found. */
export type Reach =
  /** The Group row itself. */
  | { by: 'self' }
  /** Has a group_id column — a direct filter. Asserted against the schema below. */
  | { by: 'group' }
  /** No group_id. Reachable ONLY by joining through this model, which must itself be reachable. */
  | { by: 'parent'; through: string }
  /**
   * Keyed on a subject with no path to a tenant: the id of a user, or an email in a column that is
   * also the primary key. The subject list must be captured BEFORE any transaction that removes
   * users — re-deriving it afterwards finds nobody and reports a clean sweep over what remains.
   */
  | { by: 'subject'; keyedOn: string }
  /** Not tenant-scoped at all — platform-wide. Nothing here can be per-tenant anything. */
  | { by: 'global' };

export type Entry = {
  reach: Reach;
  /** 'omit' REQUIRES a reason: an omission nobody wrote down is indistinguishable from an oversight. */
  take: 'export' | 'omit';
  because?: string;
  /** Columns removed from an exported row. Credential material, asserted to exist below. */
  redact?: readonly string[];
  /** Rows point at bytes outside Postgres. A row-only export is an index to files they cannot read. */
  blob?: 'r2';
};

const TENANT = (extra: Partial<Entry> = {}): Entry => ({ reach: { by: 'group' }, take: 'export', ...extra });
const VIA = (through: string, extra: Partial<Entry> = {}): Entry => ({ reach: { by: 'parent', through }, take: 'export', ...extra });
const OURS = (because: string): Entry => ({ reach: { by: 'global' }, take: 'omit', because });
const OURS_PER_TENANT = (because: string): Entry => ({ reach: { by: 'group' }, take: 'omit', because });
const CREDENTIAL = (reach: Reach): Entry => ({ reach, take: 'omit', because: 'credential material — exporting it would hand over the means to authenticate, and it is reissued rather than carried' });

/**
 * EVERY MODEL. Grouped for reading only; the invariants do not care about the order.
 */
export const TENANT_MANIFEST: Readonly<Record<string, Entry>> = {
  // ── THE TENANT ────────────────────────────────────────────────────────────────────────────────
  // blob: the tenant's logo (logo_r2_key) is on every invoice PDF they ever issued — an export
  // without those bytes cannot reproduce their own documents. Found by the gate, not by hand.
  Group: { reach: { by: 'self' }, take: 'export', blob: 'r2' },

  // ── THE WORKSHOP: what the garage did, for whom, to which car ─────────────────────────────────
  Site: TENANT(),
  SiteConfigEvent: TENANT(),
  SiteFeature: VIA('Site'),
  ProfitCentre: VIA('Site'),
  Resource: VIA('Site'),
  PublicHoliday: TENANT(),
  Role: TENANT(),
  User: TENANT({ redact: ['passwordHash', 'invite_token_hash', 'reset_token_hash'] }),
  UserSite: VIA('User'),
  Customer: TENANT(),
  ContactPreferenceEvent: TENANT(),
  Vehicle: TENANT(),
  VehicleIdentity: TENANT(),
  VehicleOwnership: VIA('Vehicle'),
  VehicleOdometerReading: TENANT(),
  VehicleDueItem: TENANT(),
  DueItemLine: TENANT(),
  DueItemCustomerAnswer: TENANT(),
  TyreReading: TENANT(),
  BatteryReading: TENANT(),
  ServiceScheduleReading: TENANT(),
  JobCard: TENANT(),
  JobCardItem: VIA('JobCard'),
  JobCardPhoto: TENANT({ blob: 'r2' }),
  JobClockSession: TENANT(),
  Booking: TENANT(),
  DiaryNote: TENANT(),
  QuoteVersion: TENANT(),
  QuoteVersionLine: VIA('QuoteVersion'),
  // Reachable through its version, which is how it avoids a second copy of the tenant id.
  QuoteOption: VIA('QuoteVersion'),
  QuoteOptionGroup: VIA('QuoteVersion'),
  // The draft half, reachable through the card it is being written on.
  QuoteOptionDraft: VIA('JobCard'),
  QuoteOptionGroupDraft: VIA('JobCard'),

  // ── THE MONEY: documents frozen at issue, and what settled them ───────────────────────────────
  Invoice: TENANT(),
  InvoiceLine: VIA('Invoice'),
  InvoiceSequence: TENANT(),
  CreditNote: TENANT(),
  CreditNoteLine: VIA('CreditNote'),
  Payment: TENANT(),
  PaymentMethod: TENANT(),
  Refund: TENANT(),
  TaxRate: TENANT(),
  Overhead: TENANT(),
  Cost: TENANT(),
  CostRate: VIA('Cost'),
  CostInstance: VIA('Cost'),
  CostAllocation: TENANT(),
  CostPerson: TENANT(),
  EmploymentEvent: TENANT(),
  LeaveRecord: TENANT(),

  // ── THE PRICE LIST ────────────────────────────────────────────────────────────────────────────
  CatalogueItem: TENANT(),
  CatalogueAlias: TENANT(),
  CatalogueComponent: VIA('CatalogueItem'),
  CatalogueItemTierPrice: VIA('CatalogueItem'),
  CatalogueSet: TENANT(),
  // TENANT, not VIA('CatalogueSet'), and the invariant is what settled it. I wrote VIA first on the
  // reasoning that a membership has no life without its set — true, and not what this axis asks.
  // `reach` asks whether a query can FIND this tenant's rows, and this table carries its own
  // group_id, so it can. The invariant refused the claim outright (NO_PATH_TO_PARENT: no relation
  // named for the parent and no catalogue_set_id column), which is the check doing its job on a
  // story rather than on the schema.
  CatalogueSetMember: TENANT(),
  ServiceCatalogue: TENANT(),
  ServiceTier: TENANT(),
  PartCatalogue: TENANT(),
  PurchaseModel: TENANT(),
  PurchaseModelDefaults: TENANT(),
  LineSplitTemplate: TENANT(),
  Promo: TENANT(),
  PromoTarget: VIA('Promo'),

  // ── CAR SALES ─────────────────────────────────────────────────────────────────────────────────
  StockItem: TENANT(),
  StockDisposal: TENANT(),
  StockCost: TENANT(),
  StockCostSnapshot: TENANT(),
  StockNumberSequence: TENANT(),

  // ── TALKING TO CUSTOMERS ──────────────────────────────────────────────────────────────────────
  NotificationLog: TENANT(),
  MessageThread: TENANT(),
  MarketingContact: TENANT(),

  // ── THEIR OWN TRAIL, AND THEIR OWN IMPORTS ────────────────────────────────────────────────────
  AuditLog: TENANT(),
  ImportBatch: TENANT(),
  // Their own record of asking for their own data. Exported, so the history travels with them —
  // including, recursively, the export that carried it.
  ExportJob: TENANT(),
  StagedInvoice: TENANT(),
  StagedLine: VIA('StagedInvoice'),

  // ── CREDENTIALS. Reachable, and never exported. ───────────────────────────────────────────────
  CustomerMagicLink: CREDENTIAL({ by: 'group' }),
  Account: CREDENTIAL({ by: 'parent', through: 'User' }),
  Session: CREDENTIAL({ by: 'parent', through: 'User' }),
  TwoFactorSecret: CREDENTIAL({ by: 'subject', keyedOn: 'subject_id' }),
  TwoFactorRecoveryCode: CREDENTIAL({ by: 'subject', keyedOn: 'subject_id' }),
  DeliveredCode: CREDENTIAL({ by: 'subject', keyedOn: 'subject_id' }),
  VerificationToken: CREDENTIAL({ by: 'subject', keyedOn: 'identifier' }),
  AuthRateLimit: {
    reach: { by: 'subject', keyedOn: 'key' }, take: 'omit',
    because: 'transient rate-limit counters whose keys embed a raw IP; bounded by the time-based reaper, meaningless outside this deployment',
  },

  // ── OUR RELATIONSHIP WITH THEM. Theirs to see, not theirs to take. ────────────────────────────
  GroupBilling: OURS_PER_TENANT('our subscription relationship with this tenant, including Stripe identifiers — not a record of their business'),
  GroupFeature: OURS_PER_TENANT('our feature flags for this tenant — our configuration, not their data'),
  SmsTopUp: OURS_PER_TENANT('what they bought from us; it belongs on our invoices to them, not in their workshop records'),
  ApplicationFeeRate: OURS_PER_TENANT('our commercial terms with this tenant'),
  ProviderConnection: OURS_PER_TENANT('the Stripe Connect linkage — re-established by reconnecting, never copied'),
  CommissionEntry: OURS_PER_TENANT('our accounts payable to a reseller; deliberately survives a purge for the same reason'),
  CommissionRefusal: OURS_PER_TENANT('our own record of a commission we declined to accrue'),
  TenantAttribution: OURS_PER_TENANT('which reseller introduced them — our commission spine, written once and never theirs'),
  RepVisit: OURS_PER_TENANT('our representative’s record of visiting them, written by our staff about our sales process'),
  UploadTelemetry: OURS_PER_TENANT('platform diagnostics about upload behaviour'),
  VinReadShadow: OURS_PER_TENANT('shadow comparisons we run to evaluate a lookup provider'),
  CountryWaitlist: OURS_PER_TENANT('an address that asked us about a country we do not serve yet — our waitlist, not their customer'),
  // The commercial terms a garage signed up under. Same classification as ApplicationFeeRate, and
  // for the same reason: it is OUR side of the agreement with them, recorded so a later change to
  // what we offer cannot rewrite what they were given. They already hold these terms in writing.
  TenantPlanTerms: OURS_PER_TENANT('our commercial terms with this tenant — the plan and trial they signed up under'),
  TenantAffiliateTerms: OURS_PER_TENANT('our reward terms with the affiliate who introduced them; the money is ours to the affiliate, not theirs'),

  // ── OURS ENTIRELY: platform, reseller tier, sales pipeline, public site ───────────────────────
  Operator: OURS('a platform operator account'),
  PlatformOperator: OURS('a platform operator account'),
  SuperAdminAudit: OURS('our trail of operator actions; its target_group_id is a snapshot, not ownership'),
  SetupStepDef: OURS('operator-editable onboarding step definitions — our configuration'),
  // ONE ROW, NO GROUP COLUMN. The trial length and the affiliate reward figures we offer the next
  // garage to sign up — platform policy, reachable from no tenant at all.
  ProgrammeSettings: OURS('the programme-wide terms we offer: trial length, affiliate rewards. A single global row, not a tenant’s'),
  // ONE ROW SAYING WHICH DATABASE THIS IS. Platform infrastructure, reachable from no tenant, and
  // the one row a tenant export must never carry: it would tell a garage nothing about itself, and
  // a restored copy carrying it would claim to be production.
  Environment: OURS('which database this is — production or a test one; infrastructure, not a tenant’s'),
  NavLink: OURS('navigation on our own marketing site'),
  Document: OURS('our legal and policy content, versioned for the public site'),
  StripeEvent: OURS('our billing webhook log'),
  // The dump is the whole database, so there is no tenant this row belongs to. A garage may SEE
  // that platform backups cover its data; it cannot take a row describing six other garages.
  BackupRun: OURS('evidence of a whole-database backup covering every tenant — not a record of any one of them'),
  InboundEvent: OURS('webhook delivery de-duplication keyed on the provider’s id'),
  ConsentEvent: OURS('a public-site visitor’s cookie choice, keyed on their own consent id with no tenant anywhere'),
  CommissionRate: OURS('our reseller rate card'),
  CommissionEntryNote: OURS('our note on our own commission entry'),
  Rep: OURS('a reseller account'),
  RepMagicLink: OURS('a reseller’s sign-in credential'),
  RepLead: OURS('a lead a reseller logged'),
  RepVisitAnswer: OURS('answers our representative recorded on a visit'),
  RepVisitNote: OURS('notes our representative wrote on a visit'),
  RepInvoice: OURS('our invoice to a reseller'),
  RepInvoiceLine: OURS('a line on our invoice to a reseller'),
  RepPayRun: OURS('our payment run to resellers'),
  ResellerEnquiry: OURS('someone asking to become a reseller'),
  // Beside its reseller twin on purpose: a waiting-list entry is an email address belonging to a
  // PERSON who is not a tenant and may never be one. It has no group_id, so a tenant export cannot
  // reach it and a tenant purge has nothing to take.
  AffiliateWaitlist: OURS('someone asking to be told when the affiliate programme opens'),
  Prospect: OURS('our sales pipeline'),
  ProspectSequence: OURS('our outreach sequence'),
  ProspectSending: OURS('an outreach message we sent'),
  ProspectSendingLease: OURS('a lock held while we send outreach'),
  ProspectSuppression: OURS('an address that asked us not to contact them'),
  ProspectVisit: OURS('a visit to our marketing site by a prospect'),
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE INVARIANTS. Checked against Prisma's own datamodel, not against this file's own claims:
 * a classification that agrees only with itself is not checked at all.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */
export const SCHEMA: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.map((f) => f.name))] as const),
);

/**
 * The faults in a manifest, as a PURE function of the manifest and the schema it claims to describe.
 * Both are parameters so a gate can plant each fault and watch this find it — a predicate asserted
 * only over data that happens to be correct is a predicate nobody has watched fail.
 */
export function auditManifest(
  manifest: Readonly<Record<string, Entry>> = TENANT_MANIFEST,
  schema: ReadonlyMap<string, ReadonlySet<string>> = SCHEMA,
): string[] {
  const faults: string[] = [];
  const named = Object.keys(manifest);

  // 1 · TOTAL BY CONSTRUCTION, BOTH WAYS. A new model must be classified; a renamed one must not
  //     leave a stale entry behind quietly satisfying a count.
  for (const model of schema.keys()) {
    if (!(model in manifest)) faults.push(`UNCLASSIFIED_MODEL: ${model} is in the schema and not in the manifest`);
  }
  for (const model of named) {
    if (!schema.has(model)) faults.push(`STALE_MANIFEST_ENTRY: ${model} is in the manifest and not in the schema`);
  }

  for (const [model, e] of Object.entries(manifest)) {
    const cols = schema.get(model);
    if (!cols) continue;

    // 2 · AN OMISSION WITHOUT A REASON is indistinguishable from an oversight, which is the whole
    //     failure mode this file exists to prevent.
    if (e.take === 'omit' && !e.because?.trim()) faults.push(`OMISSION_WITHOUT_REASON: ${model} is omitted and says nothing about why`);
    if (e.take === 'export' && e.because) faults.push(`REASON_ON_AN_EXPORT: ${model} is exported and carries an omission reason`);

    // 3 · THE CLAIM IS CHECKED AGAINST THE SCHEMA.
    if (e.reach.by === 'group' && !cols.has('group_id')) faults.push(`MANIFEST_CLAIMS_GROUP_ID: ${model} is classified by group_id and has no such column`);
    if (e.reach.by === 'parent') {
      const p = e.reach.through;
      if (p === model) faults.push(`PARENT_IS_ITSELF: ${model}`);
      else if (!schema.has(p)) faults.push(`PARENT_IS_NOT_A_MODEL: ${model} is reached through ${p}`);
      else if (!cols.has(p.charAt(0).toLowerCase() + p.slice(1)) && !cols.has(`${snake(p)}_id`)) {
        faults.push(`NO_PATH_TO_PARENT: ${model} claims to be reached through ${p} and has neither the relation nor a ${snake(p)}_id column`);
      }
      // A tenant row whose only path runs through something platform-wide cannot be found per tenant.
      const pe = manifest[p];
      if (pe && pe.reach.by === 'global') faults.push(`UNREACHABLE_PARENT_PATH: ${model} is reached through ${p}, which is not tenant-scoped`);
    }
    if (e.reach.by === 'subject' && !cols.has(e.reach.keyedOn)) {
      faults.push(`MANIFEST_CLAIMS_MISSING_COLUMN: ${model} is keyed on ${e.reach.keyedOn}, which it does not have`);
    }

    // 4 · REDACTION AND BLOBS NAME REAL COLUMNS. A redaction list that names a renamed column
    //     removes nothing and reads exactly like one that works.
    for (const f of e.redact ?? []) {
      if (!cols.has(f)) faults.push(`REDACT_CLAIMS_MISSING_COLUMN: ${model}.${f}`);
    }
    if (e.redact && e.take === 'omit') faults.push(`REDACT_ON_AN_OMISSION: ${model} is not exported, so removing columns from it means nothing`);
    if (e.blob === 'r2' && ![...cols].some((c) => c.includes('r2_key'))) {
      faults.push(`BLOB_WITHOUT_KEY_COLUMN: ${model} is marked as holding R2 bytes and names no r2 key`);
    }
  }
  return faults;
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * BOOT INVARIANT. Throws at import, like lib/stock-paperwork's UNCLASSIFIED_PAPERWORK_KEY: a
 * manifest that is wrong is worse than no manifest, because an export built on it looks complete.
 */
const FAULTS = auditManifest();
if (FAULTS.length) {
  throw new Error(`lib/tenant-manifest is not sound (${FAULTS.length}):\n  ${FAULTS.join('\n  ')}`);
}

/** The models an export must visit, in no particular order. */
export const EXPORTED_MODELS: readonly string[] = Object.entries(TENANT_MANIFEST)
  .filter(([, e]) => e.take === 'export').map(([m]) => m).sort();

/** The models an export must deliberately leave out, each with the reason it says so. */
export const OMITTED_MODELS: readonly { model: string; because: string }[] = Object.entries(TENANT_MANIFEST)
  .filter(([, e]) => e.take === 'omit').map(([model, e]) => ({ model, because: e.because as string }))
  .sort((a, b) => a.model.localeCompare(b.model));

/** Rows an export cannot find with a group_id filter, and how each one must be reached instead. */
export const BEYOND_A_GROUP_FILTER: readonly { model: string; reach: Reach }[] = Object.entries(TENANT_MANIFEST)
  .filter(([, e]) => e.take === 'export' && e.reach.by !== 'group' && e.reach.by !== 'self')
  .map(([model, e]) => ({ model, reach: e.reach })).sort((a, b) => a.model.localeCompare(b.model));

/**
 * THE CENSUS, derived from the same datamodel the boot invariant checks against. Anything wanting
 * to state how many models there are — a comment, a report, a screen — reads this instead of
 * writing a literal, because a literal has nobody to keep it honest and the schema moves.
 */
export const MANIFEST_CENSUS: Readonly<Record<
  'models' | 'exported' | 'omitted' | 'reachedByGroupFilter' | 'beyondAGroupFilter', number
>> = {
  models: SCHEMA.size,
  exported: EXPORTED_MODELS.length,
  omitted: OMITTED_MODELS.length,
  reachedByGroupFilter: Object.values(TENANT_MANIFEST)
    .filter((e) => e.reach.by === 'group' || e.reach.by === 'self').length,
  beyondAGroupFilter: BEYOND_A_GROUP_FILTER.length,
};
