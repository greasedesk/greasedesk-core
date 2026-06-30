# CLAUDE.md

## Project Brief

### What this is
`greasedesk-core` is a multi-tenant SaaS for independent UK garages: bookings,
job cards, pricing, customer comms. It is a **separate product** from the
WordPress plugin `GreaseDesk-JobCards` (which runs the owner's own workshop and
is the validated, battle-tested version of the job-card workflow). When in doubt
about how the job-card flow *should* behave, the WordPress plugin is the spec —
ask the owner for it rather than inventing behaviour.

### Who you're working with
Sole developer, not versed in DevOps/Vercel/git mechanics. He wants clean,
low-friction handoffs (the WordPress experience: a finished thing he can deploy
without fighting the toolchain). Operate the plumbing for him and explain any
step he has to take in plain language.

#### Working style
- British English throughout.
- The owner is dyslexic: correct typos silently in code, commits and config;
  flag spelling/grammar issues **before** anything user-facing ships.
- Be concise. Push back on imprecision and bad ideas — don't flatter.
- Version-stamp releases deliberately; increment, don't reset.

### Stack
Next.js 14 (pages router) · TypeScript · Prisma 6.19 · PostgreSQL on Neon ·
NextAuth 4 · Resend (email) · Tailwind 3.4 · Node 22 · deployed on Vercel
(git push to `main` triggers a deploy). Hosted on GitHub at
`greasedesk/greasedesk-core`. Working copy lives at `~/Developer/greasedesk-core`
(NOT in Google Drive or iCloud — cloud-syncing a git repo corrupts it).

### Source of truth
`prisma/schema.prisma` is canonical. The root `schema.sql` is stale/divergent —
do not treat it as authoritative; reconcile it to the Prisma schema or delete it.
The schema itself is good: faithful to the blueprint, includes `ServiceCatalogue`
and the expanded `Booking` (start/end time, service/resource). Money is `Decimal(12,2)`.
21 application tables, live in a Neon database.

### Known-broken (CONFIRMED — written against an imagined schema, never reconciled)
- `pages/api/jobcard.ts` — queries `include: { intakePhotos, checklist }`. Neither
  exists; the relation is `photos`, and there is **no checklist model**. Throws at runtime.
- `pages/api/bookings.ts` — filters on `date` and selects `customer_name` / `vehicle_reg`.
  None exist on `Booking`; use `booking_date` and join `Customer`/`Vehicle`. Throws at runtime.
- The operational core (create/work/sign-off a job card) is essentially unbuilt. What exists
  is the auth + onboarding + billing-setup scaffolding around it.

### State of the admin area (audited)
- **Settings** (`/admin/settings`) — the one genuinely real page: reads via SSR and writes via
  a Prisma transaction with ownership validation. Use it as the reference PATTERN for new features.
- **Dashboard** (`/admin/dashboard`) — painted-on; tiles are hardcoded numbers, no DB contact.
- **Bookings/Job Cards** — pages exist at `/bookings` and `/jobcard/[id]` (not under `/admin`),
  APIs are the broken stubs above; the job-card page is a static placeholder.
- **Customers / Reports** — do not exist yet.
- Admin nav links to four `/admin/*` routes that have no page files (404). Reconcile when building.

### Conventions to enforce
- Standardise auth on `lib/auth-context.ts` (`requireAuthContext`). Remove the parallel inline
  `getServerSession` pattern (e.g. in `bookings.ts`).
- Permission enforcement IS built: route through the chokepoints in "Engineering Disciplines"
  (`getVisibility`, `canManageSite`, `requireAdminPage/Api`). The richer two-axis `can()` (below)
  is the future target; the legacy `roles.permissions` JSON is still unused.
- Every query and route must be tenant-scoped by `group_id` (and `site_id` where relevant).
  Treat a missing scope as a bug.

### Security (resolved — for the record)
The old `env_file.txt` held a live Neon credential in a public repo. That credential is now dead
(its database no longer exists) and the file has been removed; `.gitignore` blocks `env_file*.txt`.
Going forward: secrets live in `.env` (gitignored) and the Vercel dashboard only — never committed.


## Engineering Disciplines (standing rules — enforce on every slice)

### i18n (mandatory for ALL new UI)
- All visible text via `t('key')` from `public/locales/<locale>/<ns>.json`. ZERO inline
  English in components — finished code has no user-facing English outside locale files.
- A whole sentence is ONE key with `{{placeholders}}` — never concatenate translated fragments.
- Pluralisation via i18next plural keys (`_one`/`_other`), never `count === 1` logic.
- Money ONLY via `formatMoney` (lib/format-money.ts) — never a hardcoded `£` or hand-formatting.
- Dates/numbers via locale-aware `Intl` helpers, never hardcoded formats.
- Enums/statuses/item-types are stored as stable lowercase keys (`in_progress`, `labour`) and
  translated for display via `t()`. NEVER render an English string straight from the DB.
- Locale/currency follow the tenant via `resolveTenantProfile`. Setup: next-i18next **v15**
  (NOT v16 — App-Router-first); `common` namespace loads app-wide via `_app`.

### Mobile-first (the product ships as a native store app)
- GreaseDesk will ship as a native App Store / Play Store app delivered via a Capacitor-style
  WRAPPER around this one Next.js codebase — NOT a separate native rebuild. One codebase,
  native shell, both stores.
- Therefore every new screen MUST be built mobile-responsive and touch-first from line one —
  finger-friendly targets, layouts that work on a phone viewport. The wrapped app IS these
  screens; desktop-only screens = rework later.
- Native features (camera, push) are DESIGNED-FOR now, built in the wrapper slice later.
  Job-card photo stages assume phone-camera capture, not just file upload.

### Chokepoints — route through the one, never scatter
Protected/computed surfaces go through the single existing helper; new surfaces EXTEND it,
they never add parallel role/site/money/country logic:
- `getVisibility` (lib/site-visibility.ts) — auth scope (group + sites).
- `canManageSite` (lib/admin-guard.ts) — site-level authority.
- `requireAdminPage` / `requireAdminApi` (lib/admin-guard.ts) — admin gating (pages + APIs).
- `formatMoney` (lib/format-money.ts) — money. `resolveTenantProfile` (lib/locale-profiles.ts)
  — country→locale/profile. Tenant `group_id` resolution — one function (see Tenancy below).

### Roles (the BUILT model — enforced server-side, not just UI)
- **ADMIN / owner** — all sites, everything. Owner is immutable (cannot be demoted or removed).
- **SITE_MANAGER** — at ASSIGNED sites only: manage resources + manage/invite STANDARD users.
  CANNOT grant SITE_MANAGER/ADMIN, create locations, or access Financial/Licences.
- **STANDARD** — Settings = own Profile only.
- This is today's concrete implementation; the two-axis `can()` (scope × mode) design below is
  the richer target it grows into — not a contradiction.

### Schema & migrations
- Plan first: SHOW the migration SQL and get approval BEFORE running it.
- Additive / non-destructive — the local `.env` DB IS prod; never destructive against live data.
- Enum changes: hand-written type-rebuild (CREATE new type → cast → drop → rename), NOT
  `prisma migrate` auto-gen.
- Data backfills ship as COMMITTED migrations, never ad-hoc node scripts (those never reach prod).

### Deployment verification (learned the hard way)
- Some bugs are invisible to ALL local runs (dev AND `npm run start`): Vercel's serverless
  filesystem is built from `@vercel/nft` traces, not your local disk. next-i18next read locale
  files from a `process.cwd()` path nft couldn't trace → missing on Vercel → raw keys. Fixed with
  `experimental.outputFileTracingIncludes: { '/**': ['./public/locales/**'] }`.
- RULE: i18n/locale loading and ANY runtime file reads must be verified via `.next/server/**/*.nft.json`
  trace inspection OR a deployed/preview check — never trusted from local runs alone.


## Tenancy, Routing & Future Architecture (settled design decisions)

These are settled architectural decisions. Treat them as non-negotiable. They exist so that
later offerings (diary, phone app, white-label) slot in without a rewrite. Provisioning for
them now costs nothing today and saves a rebuild later.

### Foundational principle — single source of truth
- The **job card lives in the SaaS and is the single source of truth.** Everything else
  (diary entries, external calendars, the phone app, public websites) is a *view* of it,
  never a second master.
- A diary/booking entry and its job card are the **same underlying object**. The entry is how
  you find the job; the job card is the job.

### Tenancy & routing — subdomain-per-tenant FROM ITERATION ONE
- Each tenant (Group) is reached at its own subdomain: **`{slug}.greasedesk.com`**, where the
  slug is derived from the garage's name and stored on the Group record.
- `{slug}` is a per-tenant placeholder — e.g. `tmbs.greasedesk.com`, `smithsgarage.greasedesk.com`.
  It is NOT a literal fixed subdomain.
- **The owner's own garage is the live stress-test tenant: slug = `tmbs` → `tmbs.greasedesk.com`.**
- **Users are email-based and scoped to their tenant.** A login belongs to one Group's
  subdomain context; users do not log in to the platform at large.
- Build tenant resolution as **one central chokepoint function**: "given this request, which
  `group_id`?" The subdomain identifies the tenant before login. Never scatter tenant detection
  across the codebase — one function, taught new tricks later.
- Every read and write must be scoped to the resolved `group_id` (and `site_id` where relevant).
  A missing scope is a bug — this is how tenant isolation is enforced.
- Infrastructure note (config step when tenancy is built, not now): needs wildcard DNS
  (`*.greasedesk.com`) pointing at the app, with the app reading the subdomain off each request.
  Vercel supports this well.

### Provision now for later offerings (don't build yet — keep the doorways open)
- **Custom domains (later premium tier):** a garage points its own domain at the app, e.g.
  `app.theminispecialist.com`. This is just *another way to resolve to the same `group_id`* —
  so the central resolver above must be able to map a custom domain → group, not only a subdomain.
- **White-label public website (Phase 3/4 — a distinct product):** serve a customer-facing,
  themed website at the garage's own domain, powered by the booking/pricing/comms modules.
  This is potentially worth more than the management software itself (it's the owner's own
  pricing-transparency strategy, sold to garages). To keep it from being a rewrite:
  - **Public and private must be architecturally separate now.** Public-facing modules
    (booking, pricing pages) sit behind their own clear boundary and APIs, distinct from the
    private management app, even though they share one database.
  - **Theming is data, not hardcoding.** Name, logo, colours, and enabled modules come from the
    tenant record (`group_features` / `site_features` already begin this). A new white-label
    client should be a row of data, not a code change.

### Phase 2 — Diary / Calendar (build in the SaaS, after the job-card core exists)
- **Bug, priority: double-booking is data loss.** Double-booking a lift currently makes the
  first booking silently disappear. A booking must NEVER overwrite another — detect the clash
  and refuse or warn, never blind-write. Treat as a correctness bug.
- **Model resources AND events, not just lifts.** Resources (lift, MOT lane, spray booth —
  things with capacity; schema already has `resource_type`) AND events (staff leave, reminders
  like "collect car from customer", deliveries — no capacity) should both appear, as distinct
  concepts shown together.

### External calendar sync — ONE WAY ONLY, FOREVER
- Sync to iPhone / Mac / Outlook is **outbound and read-only**: the SaaS pushes a shadow entry
  ("08:30 Lift 2 — Mrs Patel, BMW 320d, brake job") so the day can be glanced at in the calendar
  the user already lives in.
- **NEVER a two-way sync.** External-calendar edits must never flow back into the SaaS. External
  calendars cannot represent a job card, so letting them edit it would silently corrupt the real
  record. This temptation will recur ("wouldn't it be handy if…") — the answer is always no.

### Phase 3 — Phone app
- A **rich client** onto the SaaS job card — which is why it exists and why calendar sync alone
  is not enough (a calendar can't show or edit a job card).
- **Calendar = primary interface; job card = core.** The calendar is how a mechanic navigates
  their day (the way in); tapping an entry lands on the rich job card (what's there). Keep these
  roles distinct — the calendar is a view onto the job card, never the thing itself.
- Must tolerate poor workshop signal: works offline, syncs when back online. This shapes how job
  cards are identified — the phone must create/name a card offline and reconcile cleanly when
  signal returns. Bake this into the job-card core, not later.


## Job-Card Lifecycle & Spec (ported from the proven WordPress plugin)

The WordPress `GreaseDesk-JobCards` plugin is the **canonical behavioural spec** for the job
card. Build the SaaS to match it; do not invent behaviour. Port it in deliberate SLICES (see
build order at the end) — do NOT attempt the whole thing in one go.

### The pipeline (a card moves left to right)
The workshop portal is organised as tabs, each a stage of one pipeline:
- **Callbacks** — enquiry received, needs a call + a price. Build the estimate, "Send quote" → moves to Quotes.
- **Quotes** — quote sent, awaiting customer decision. Customer accepts online, picks a slot → moves to Diary. "Resend quote" nudges; "Promote to Job Card" converts directly.
- **Job Cards** — booked/scheduled jobs (and "Accepted/unscheduled — no date yet").
- **Diary** — calendar view: lifts as columns, time-slot rows (9–11, 11–13, 14–16, 16–18), each job a circle (solid = on a job, ring = free), tick = completed, gear = awaiting parts; £ totals per day and per week.
- **Completed** — finished job cards (booked date, completed date, customer).
- **Archived** — hidden from live lists; "Restore" brings back.
- **Search** — find current + completed cards by reg, customer, or phone.
- **Messages** — per-customer SMS/WhatsApp/portal threads (NOT yet wired in WP — Phase later).

### Job-card status — four stages, each Pending/Done
Every card tracks four sequential stages, shown as badges:
1. **Job Card** (the details/estimate) 2. **Intake Photos** 3. **In-Job** (photos + notes) 4. **Complete Photos**
Plus an overall status (Booked → Completed) and "Mark as Completed" / "Mark as Pending".

### Job-card fields (main tab)
- Vehicle/customer: registration, customer name, phone, email, VIN, current mileage.
  **Reg autofill:** if the customer/vehicle is already known, entering the reg autofills their details.
- **Flags:** Urgent/Priority, Sales Car, Customer Car, MOT (MOT bay needed), DIAG (diagnostic).
- **Scheduling:** start day, start slot, end day, end slot (multi-day for awaiting-parts), lift
  assignment, "Held on lift until released (e.g. awaiting parts)". Leave dates blank if accepted
  but not yet scheduled.
- **Estimate / Quote builder:** labour lines (description, hourly rate, hrs, VAT, total) + parts
  lines (description, unit price, qty, VAT, total) → subtotals → VAT % → Total. **When lines exist,
  the quote total auto-sets the card Value.**
- **Value (£)**, and "Booked work (from online booking)".
- **Garage notes (internal — never shown to customer).**
- **Notes for the customer** — date-stamped, shown newest-first in the customer portal; editable.
- **Send update to customer** (SMS/Email, optional extra message) — saves card + notifies via portal link.
- **Messages with customer** — full two-way thread (SMS/WhatsApp/portal).
- **Referral discounts**, **Invoice (PDF)**, **Service schedule** (due in miles / due by month — feeds reminders), **Status** dropdown, **History** log (date-stamped, who did what).
- **Customer portal link** per card — shows that customer their vehicles, history, photos.

### Photo stages
- **Intake Photos:** fixed slots — Front, Left, Rear, Right, Engine Bay, VIN, Mileage, Inside Left,
  Inside Right, Rear Seats, Boot Area (multiple per slot; high-res view; timestamped).
- **In-Job:** free-form photos + per-photo captions + in-job notes (e.g. "Draining the oil").
- **Complete Photos:** same slot set as intake, for the finished state.

### HARD RULE — invoice gate
**An invoice must NOT be generatable until all four stages AND their required photos are complete.**
This protects the garage (no invoice without evidence) and enforces correct workflow sequencing.
Treat as a non-negotiable gate, the same class of rule as the double-booking guard.

### Build order (slices — build one, prove it, then the next)
1. **Spine:** create / view / list a job card — vehicle+customer fields, the four-stage status,
   tenant-scoped to `group_id`, using the Settings page as the working pattern. Fix the broken
   `api/jobcard.ts` and `api/bookings.ts` against the real schema as part of this.
2. **Estimate/quote builder** — labour + parts lines, VAT, total auto-setting Value.
3. **Photo stages** — intake / in-job / complete, with the slot model.
4. **Invoice** — behind the gate above.
5. **Diary** — lifts/resources + events (see Phase 2 design); fix double-booking.
6. **Customer messaging / portal** — SMS/WhatsApp threads, portal link.


## Tenancy & Access Architecture (settled design — build slices against this)

> **Refined by the "Navigation Shell & HQ-as-Group Refinement" section below.** Where they conflict
> (head-office-as-a-Site, `parent_site_id` as the reporting/billing anchor), the refinement wins.

This is the spine the whole SaaS hangs off. Capture it correctly before building; then
build in deliberate slices. Provision the structure now (schema), defer the UI where noted.

### The hierarchy
```
Group (tenant; the business; the BILLING entity)
  └─ Site  (a node; one is Head Office)
       ├─ Site (child)              ← parent/child via optional parent_site_id on Site
       ├─ Profit Centre (optional)  ← a TYPED business unit; a site may have zero or many
       │     └─ Resource            ← lift / MOT bay / spray booth (the diary's columns)
       └─ ...
```

### Group = tenant = billing entity
- The Group is the tenant and the unit that is billed.
- **Billing is driven by site count.** Number of sites is declared at signup (see onboarding)
  and changes billing. Adding a site later (in admin) must also update billing — site creation
  has a billing hook. (Billing itself is a later module; the data model must anticipate it now:
  Group = billing entity, Sites = billable units.)

### Site = a node in the hierarchy; "Head Office" is a ROLE a site plays
- One site per Group is **Head Office**, set at signup (it is the billing/reporting anchor and
  the parent of child sites). More sites can be added later in admin.
- Sites form a parent/child tree: Head Office is the parent; branches are children
  (optional `parent_site_id` on Site — additive schema change, provision now).
- **A site is OPTIONALLY operational and/or administrative — these are independent:**
  - *Operational* = it trades: has Profit Centres + Resources, a diary, job cards. (Every child
    site; and Head Office IF it also trades.)
  - *Administrative* = Head Office capability: cross-site reporting + tenant admin.
  - **Head Office may have ZERO profit centres** — a purely administrative head office (central
    office over branches, no workshop of its own) is a valid, supported configuration. Never bake
    in "Head Office always trades."

### Profit Centre = a TYPED business unit (per site)
- Examples of type: Repairs, MOT, Spraybooth, Car Sales (future).
- **Typed deliberately**, drawn from a shared category list, so cross-site reporting can slice by
  category ("Repairs P&L across all sites"). A free-text label would make this impossible.
- A Profit Centre belongs to exactly one Site. A Site may have zero or many.

### Resource = a physical unit within a Profit Centre
- A lift, MOT bay, or spray booth. Belongs to exactly one Profit Centre.
- Fields: name (e.g. "Lift 2"), type (lift / MOT bay / spray booth), and a display order
  (for diary column ordering).
- **These are the diary's columns** — the diary groups by Profit Centre, then shows each Resource
  as a column. (Ties to the diary's `resource_type` concept in the Phase 2 design.)

### Permission model — TWO axes (this is what the `can()` helper must encode)
The long-standing `can(user, action, siteId)` helper must express permission on two independent axes:
1. **Scope** — which site(s) a user can touch: their own site, or all sites under the Group.
2. **Mode** — what they may do there: *operational* (create/edit job cards, run the diary) vs
   *reporting* (read P&L, no edits).

Resulting roles (illustrative):
- **Child-site user:** own-site scope; operational + reporting on that site.
- **Head-office user:** all-sites scope, but **reporting mode only** on other sites
  (consolidated P&L, cross-site slice-and-dice) — NOT operational control of child sites.
  Plus operational on Head Office's own site IF it trades; plus tenant admin.
- A purely-administrative Head Office user = all-sites *reporting* + tenant admin, zero operational.

**Key rule: Head Office gets reporting visibility into child sites, NOT operational visibility.**
Head office can see a child site's numbers; it cannot reach in and edit that child's job cards or
diary. Do not collapse these two into one "admin sees everything" permission.

### Onboarding (signup wizard) — provision the above
- Existing wizard: Step 1 account → Step 2 financial (currency/VAT/labour) → Step 3 team invites.
- **Add a step: "How many sites?"** with a clear instruction that the FIRST site is treated as
  Head Office, and more sites can be added later in admin. This captures the billing input and
  establishes the Head Office node.
- Profit centres/resources are managed in the **admin area** (editable forever), not forced into
  the wizard — though the wizard may later seed them. The admin page is the real prerequisite for
  the diary; the wizard step is a nicety.

### Reporting (later module) — design now so it's possible
- Cross-site "slice and dice": profit per functional area (e.g. Repairs) across multiple sites.
- Made possible by typed Profit Centres (category is the slice dimension) + the Group hierarchy.
- Not built now; the typing + hierarchy above are the provision that keeps it possible.

### Car Sales (later module) — provision now
- Car Sales is just another **Profit Centre type** (the job card already has a "Sales Car" flag).
- No Car Sales code now; designing Profit Centres as typed business units is the whole provision —
  it drops in later as a new type without structural change.

### Build order off this spec
1. **Admin: Profit Centres & Resources** for a single site (typed profit centres; resources within).
   Schema provisions multi-site (Site.parent_site_id) + Head Office flag now; admin UI stays
   single-site for this slice.
2. **Onboarding "how many sites" step** + Head Office designation (billing anchor).
3. **Diary** (renders Profit Centre → Resource columns; double-booking guard).
4. **`can()` two-axis permission model** (scope × mode) — enables safe multi-site + head-office reporting.
5. **Multi-site management UI** (add/manage child sites in admin).
6. Later modules: Reporting (cross-site P&L), Car Sales, billing.


## Navigation Shell & HQ-as-Group Refinement (settled design — supersedes "one site is Head Office")

This refines the Tenancy & Access Architecture above. Where that section says "one Site is Head
Office," read it through this lens: **HQ / consolidated reporting lives at the GROUP level, not at a
Site.** Every physical location — including the head-office workshop — is just a Site.

> **Further refined by "Operational Model — Location→Resource, Profit Centre as Tag" below**: Resources
> belong to Locations (Sites), and Profit Centre is a reporting tag — not a container for resources.

### The core refinement
- **"HQ" = the Group's consolidated reporting view ("All Sites").** It is NOT a special Site.
- **Every physical location is an ordinary Site** — including the location that happens to be head
  office. Example: HQ = "TMBS" (the business / reporting entity); "Great Bridge" = a Site (the
  workshop). Same building, but distinct concepts: TMBS is the reporting layer, Great Bridge is a
  location tab.
- This removes the awkward "empty head-office site." A **purely administrative HQ** is simply a
  Group whose "All Sites" reporting view has no operational Site of its own — no placeholder site
  needed.
- Consequence for schema: the parent/child `parent_site_id` is still useful for site grouping, but
  the reporting/billing anchor is the **Group**, not a designated "head office" Site. Drop the
  notion of a special head-office Site flag; HQ is the Group.

### Navigation shell (the same shape for 1 site or 100)
The navigation IS the hierarchy (Group → Site → Profit Centre), which is why it scales without
special-casing:

- **Top bar = `[ All Sites ]` + one tab per Site (location).**
  - `[ All Sites ]` is the Group-level consolidated **reporting** home — the default landing for an
    HQ user. Shows cross-site P&L and the slice-and-dice by functional area (Repairs across all
    sites, etc.).
  - Selecting a specific location tab drops into **that Site's operational view**.
- **Side bar = the functional areas (Profit Centres) within the selected location.**
  - Repairs, MOT, Spraybooth, … for that Site. From 1 to however many.
- **Single-site case is not special-cased:** a one-location garage simply sees
  `[ All Sites ] [ Great Bridge ]` — two tabs — and the sidebar is Great Bridge's profit centres.
  Identical structure, fewer items.

### What this means operationally vs reporting (ties to the two-axis permission model)
- **All Sites view** = Group-level, **reporting mode only** (consolidated P&L; no operating a
  workshop from here).
- **A location tab** = that Site's **operational** view (diary, job cards) for users with
  operational scope there, and/or that Site's local reporting.
- Head-office reporting visibility into child sites = being able to land on `All Sites` and on each
  location tab in **reporting mode**, without operational control of locations that aren't yours.

### Onboarding — declare locations, then per-location setup fork
At signup, after the account step:
1. **"How many locations?"** — with a clear note that this drives billing and more can be added
   later in admin. (Billing input lives at the Group.)
2. **HQ operation type** — ask up front whether HQ itself trades (has an operational location of
   its own) or is purely administrative (reporting only). Decides whether the wizard shows a
   profit-centre setup step for HQ's own location.
3. **Per declared location, a setup fork:**
   - **Set up centrally now** — HQ configures that location's profit centres + resources during
     onboarding (or later from the per-site admin page).
   - **Delegate to a site manager** — capture the manager's name + email; they receive an invite to
     set up their own location. HQ retains *visibility* of that location's setup either way.
4. **Financial rates** and **team invites** as today (team invites skippable).

### Per-site admin page (needed regardless of the delegation choice)
- HQ gets a **per-location admin page** to view/manage each Site's setup (profit centres, resources,
  team) — because even when setup is delegated, HQ wants visibility of every location's
  configuration. This is an extra admin menu item that appears for multi-site Groups.
- Fits the permission model: HQ has reporting/visibility into every site's *configuration*, not just
  its P&L; operational control of a delegated site stays with that site's manager.

### Net effect on the build order
- Build order item 1 (Profit Centres & Resources admin) is unchanged, but the navigation shell
  (top bar = locations, sidebar = profit centres, All Sites = Group reporting home) becomes the
  frame it slots into. Build the shell as the app's primary navigation; everything renders inside it.
- Schema: anchor reporting/billing on **Group**; Sites are plain locations (keep `parent_site_id`
  for grouping if useful, but no special head-office Site).


## Operational Model — Location→Resource, Profit Centre as Tag (supersedes "Resource under Profit Centre")

This supersedes the earlier "### Resource = a physical unit within a Profit Centre" and the diary's
"groups by Profit Centre → Resource" wording. The operational tree is now **three levels**:

```
Group (tenant / HQ)
  └─ Site  (a Location — the physical branch; "Location" is the UI name for Site)
       └─ Resource  (lift / MOT bay / spray booth — the diary's columns)
```

- **Resources belong to a Site (Location), not to a Profit Centre.** `Resource.site_id`.
- **Profit Centre is a reporting TAG, not an operational container.** It is a typed tag
  (`ProfitCentreCategory`: repairs / mot / spraybooth / car_sales) applied to **job cards &
  bookings** via their (now nullable) `profit_centre_id`. It owns no resources and is not required
  to operate. P&L reporting slices by the tag's category across sites.
- **Job cards/bookings no longer require a profit centre.** `JobCard.profit_centre_id` and
  `Booking.profit_centre_id` are nullable; onboarding no longer auto-creates a "Workshop" PC.

### Navigation & Settings shape (built)
- **Top bar = locations** (one tab per Site; current highlighted). Switching between locations is a
  later slice; `[ All Sites ]` reporting home is also later.
- **Settings is split into sub-sections:** **Financial** (regional/VAT/labour + Profit Centre
  *tags*), **Locations & Resources** (resources per location), **Users** (read-only list for now),
  **Licences & Subscriptions** (read-only plan/billable-unit view).
- The standalone `/admin/profit-centres` page is gone; profit-centre tags live under Settings →
  Financial, resources under Settings → Locations & Resources.
