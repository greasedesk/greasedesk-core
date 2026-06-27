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
- There is **no permission enforcement** yet. `roles.permissions` (JSON) exists but nothing reads
  it. Implement a single `can(user, action, siteId)` helper and route all checks through it.
- Every query and route must be tenant-scoped by `group_id` (and `site_id` where relevant).
  Treat a missing scope as a bug.

### Security (resolved — for the record)
The old `env_file.txt` held a live Neon credential in a public repo. That credential is now dead
(its database no longer exists) and the file has been removed; `.gitignore` blocks `env_file*.txt`.
Going forward: secrets live in `.env` (gitignored) and the Vercel dashboard only — never committed.


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
