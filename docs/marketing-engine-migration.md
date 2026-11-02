# The marketing engine — the migration, for your yes

Proposed 2026-11-02. Nothing applied. Two migrations, deliberately: the first is additive and safe
to apply whenever you like, the second only after the code that stops using the old tables is live.

## What I measured first, because it changes the answer

Production, read-only, this morning:

| | rows |
|---|---|
| `Prospect` | **0** |
| `ProspectSequence` | **0** |
| `ProspectSending` | **0** — no row, so prospect sending has never been switched on |
| `ProspectSuppression` | **0** |
| `AffiliateWaitlist` | **0** |
| `GroupBilling` where `subscription_status='trialing'` and never paid | **4** |
| `GroupBilling` where `first_paid_at` is set | **0** |
| `Rep` where `party_type='affiliate'` | **1** (terms accepted, email verified) |
| `TenantAttribution` | **1** |

**The existing prospect engine has never run and holds no rows.** That is the fact the whole design
turns on. Generalising it into one engine is therefore a schema change over empty tables — no
backfill, no data to mangle, no risk of a half-migrated sequence. Had there been live sequences
mid-flight I would be proposing something much more cautious and much worse.

The second number that matters: **four trial garages and one affiliate.** The populations these
sequences exist for are about to be created, not reorganised.

## Why the existing table cannot take a second audience

`ProspectSequence` is the right machine with one audience welded into its primary key:

```prisma
model ProspectSequence {
  prospect_id String @unique
  prospect    Prospect @relation(…, onDelete: Cascade)
}
```

A trial garage is a `Group`, a waitlist entry is an `AffiliateWaitlist`, a new affiliate is a `Rep`.
None of them is a `Prospect`, and Postgres has no polymorphic foreign key. Keeping that column and
adding three more nullable ones would make four columns of which exactly one is ever set, with no
constraint able to say which — and the state machine, the switch, the stop reasons, the claim-before-send
and the cron would each need a second copy. That is the "building alongside" you told me not to do.

## Migration 1 — additive. Safe to apply at any time.

`20261102_marketing_engine` — four new tables, nothing dropped, nothing altered.

```prisma
/// ONE ENGINE, FOUR SEQUENCES.
///
/// NO FOREIGN KEY TO THE SUBJECT, deliberately: the four audiences live in four tables and Postgres
/// has no polymorphic reference. The pair (subject_type, subject_id) IS the reference,
/// MarketingEnrolment_pair_chk holds the four legal combinations, and the runner treats a subject it
/// cannot resolve as a STOP with a reason, never a crash — an enrolment whose person has gone must
/// stop trying rather than retry for ever.
///
/// NO EMAIL COLUMN, deliberately and importantly. The address is read from the subject at send time.
/// A copy here would be a second home for personal data outside lib/prospect-store::stripPersonal,
/// which is the ONE writer that removes a prospect's email — and a retention rule with a second copy
/// it cannot reach is not a retention rule.
model MarketingEnrolment {
  id           String @id @default(uuid())
  sequence_key String   /// lib/marketing-engine SEQUENCE_KEYS; constrained in the database
  subject_type String   /// constrained, and PAIRED with sequence_key by a CHECK
  subject_id   String

  state          String    /// 'active' | 'stopped' — the same two CHECKs ProspectSequence had
  next_step      Int
  next_due_at    DateTime? /// NULL exactly when stopped
  started_at     DateTime
  last_sent_at   DateTime? /// NULL = nothing sent yet
  stopped_at     DateTime? /// NULL exactly while active
  stopped_reason String?   /// NULL exactly while active — a stop always says why

  /// WHY THIS SEND IS ALLOWED, frozen at enrolment: the source ('rep_visit' | 'waitlist_form' |
  /// 'signup' | 'affiliate_terms') and the moment it was given. FROZEN because it records what the
  /// enrolment was JUSTIFIED BY. What the send is SUBJECT TO — suppression, customer status, the
  /// switch — is read live, every time, and never frozen.
  consent_source String
  consent_at     DateTime

  created_at DateTime @default(now())

  @@unique([sequence_key, subject_type, subject_id])
  @@index([state, next_due_at], map: "MarketingEnrolment_due_idx")
  @@index([subject_type, subject_id], map: "MarketingEnrolment_subject_idx")
}

/// WHETHER ONE SEQUENCE SENDS. One row per sequence; NO ROW = OFF, which is the default and the
/// state every sequence ships in. Four independent switches, audited to SuperAdminAudit on change.
model MarketingSending {
  sequence_key String   @id
  enabled      Boolean
  changed_at   DateTime
  changed_by   String   /// the operator who made the CURRENT decision; history is in SuperAdminAudit
}

/// A GATE'S OVERRIDE, NEVER THE OWNER'S SWITCH — the ProspectSendingLease pattern, unchanged, now
/// keyed on the enrolment so it can have a real foreign key and cascade. At most 5 minutes.
model MarketingSendingLease {
  enrolment_id String   @id
  enabled      Boolean
  created_at   DateTime @default(now())
  expires_at   DateTime
  created_by   String
  enrolment MarketingEnrolment @relation(fields: [enrolment_id], references: [id], onDelete: Cascade)
}

/// THE WORDS, EDITABLE WITHOUT A DEPLOY. One row per (sequence, step).
///
/// NO ROW, OR A BLANK BODY, MEANS THE STEP DOES NOT SEND — reported as 'no_copy', never sent as an
/// empty email and never advanced as if it had gone. The sequence holds at that step until somebody
/// writes it.
///
/// body IS PLAIN TEXT, escaped at render and wrapped paragraph by paragraph. Not markdown, not HTML:
/// the only person who types here is the owner, a parser is a second thing to get wrong, and an
/// escaped body cannot carry a tag into a real person's inbox. A call to action is two STRUCTURED
/// columns rather than a link syntax to parse — see lib/notification-templates::freeTextEmail, which
/// already takes exactly this approach for the one other owner-written body in the product.
model MarketingCopy {
  id           String @id @default(uuid())
  sequence_key String
  step         Int
  subject      String
  body         String
  cta_label String?  /// NULL together — a step either has a button or has none (MarketingCopy_cta_chk)
  cta_url   String?
  updated_at DateTime @updatedAt
  updated_by String
  @@unique([sequence_key, step])
}
```

### The CHECK constraints, and which one earns its keep

```sql
MarketingEnrolment_state_chk     -- stopped ⇒ stopped_at + stopped_reason set AND next_due_at NULL
                                 -- active  ⇒ next_due_at set AND stopped_at + reason NULL
MarketingEnrolment_step_chk      -- next_step BETWEEN 1 AND 5
MarketingEnrolment_pair_chk      -- (sequence_key, subject_type) IN the four legal pairs
MarketingSendingLease_short_chk  -- expires_at <= created_at + 5 minutes
MarketingCopy_step_chk           -- step BETWEEN 1 AND 5
MarketingCopy_cta_chk            -- cta_label and cta_url are both NULL or both set
```

The first two are the ones `ProspectSequence` already had, carried over verbatim because they were
right. **`MarketingEnrolment_pair_chk` is the new one that matters**: without it, a
`trial_garage` enrolment could carry a `Prospect` id, and the one thing this table must never do is
send an audience's email to somebody from a different audience. A pair constraint in the database is
the only version of that rule a future writer cannot forget.

## Migration 2 — destructive. ONLY after the code is live.

`2026…_retire_prospect_sequence` — drops `ProspectSequence`, `ProspectSending`,
`ProspectSendingLease`, and the two relation fields on `Prospect`.

**It must not be applied before the push.** `lib/prospect-store::recordVisit` is deployed and writes
`ProspectSequence` every time a rep records a visit with an address; dropping the table under the
running deployment turns that into a 500. One database, two writers, and the old writer is live
until the push replaces it — the rule the schema-drift discipline exists for.

Because the tables are empty and the switch has never been on, the *consequence* of getting this
order wrong is small today. The order is still the order.

## What this does NOT change

- **`ProspectSuppression` is untouched and reused exactly as it is.** The hash of a normalised
  address is audience-agnostic; one unsubscribe list serves all four sequences, which is both the
  simpler rule and the honest reading of an unsubscribe.
- **`Prospect`, `AffiliateWaitlist`, `Rep`, `Group`, `GroupBilling` are untouched.** Every stop
  condition you asked for already has a column: trial start is `Prospect.signed_up_at`, first
  payment is `GroupBilling.first_paid_at` (written once by the `invoice.paid` handler), joining is a
  `Rep` row appearing with that address, and a first referred garage is a `TenantAttribution` row.
  Nothing new is needed to know when to stop.
- **No tenant data is read or written by the engine** beyond the four trial-garage addresses.

## Two consequences I am flagging rather than burying

**1. The tenant purge needs a seventh table.** `MarketingEnrolment` rows with
`subject_type = 'group'` belong to a tenant, and the purge sweep currently clears six subject-keyed
tables. If a purged tenant's nurture enrolment survives, it is an enrolment pointing at a garage
that no longer exists. The other three subject types are ours and must NOT be swept. I will add it
to the sweep and to `lib/tenant-manifest`, and `purge-completeness-gate` will go red until I do —
which is the gate working.

**2. The subdomain needs a code change, not just DNS.** There is one from-address in the codebase
and every message uses it. See `docs/marketing-subdomain-dns.md` — step 4 is the part that is mine.
