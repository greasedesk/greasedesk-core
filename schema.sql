-- ============================================================================
-- GreaseDesk Core Schema v1.2
-- This matches the GreaseDesk Core Blueprint v1.2
-- Multi-tenant: all tenant data is isolated by group_id...
-- ============================================================================

-- For UUID generation if we want UUID primary keys instead of SERIAL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. GROUP / BILLING / FEATURES
-- ============================================================================

CREATE TABLE groups (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_name          TEXT NOT NULL,         -- Legal / HQ name
    trading_name        TEXT,                  -- Public name
    company_number      TEXT,
    vat_number          TEXT,
    address             TEXT,
    billing_email       TEXT NOT NULL,
    is_franchise_group  BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE group_billing (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    plan_name           TEXT NOT NULL,         -- Core Basic / Core Plus / Core Pro / Multi-Site / Enterprise
    status              TEXT NOT NULL CHECK (status IN ('ok','grace','suspended')),
    retention_months    INTEGER NOT NULL,      -- how long we keep history
    included_sites      INTEGER NOT NULL,      -- how many sites included in base plan
    active_sites_count  INTEGER DEFAULT 1,
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- Feature flags at group level (things that apply org-wide like Reports, Portal, Marketing)
CREATE TABLE group_features (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    feature_key         TEXT NOT NULL,         -- e.g. 'REPORTS', 'CUSTOMER_PORTAL', 'MARKETING_BROADCAST'
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(group_id, feature_key)
);

-- ============================================================================
-- 2. SITES / SITE FEATURES / PROFIT CENTRES
-- ============================================================================

CREATE TABLE sites (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,

    site_name           TEXT NOT NULL,         -- Internal / location reference
    trading_name        TEXT,                  -- Customer-facing name
    company_number      TEXT,
    vat_number          TEXT,
    address             TEXT,
    phone               TEXT,
    email               TEXT,

    timezone            TEXT DEFAULT 'Europe/London',
    currency_code       CHAR(3) DEFAULT 'GBP',
    locale              TEXT DEFAULT 'en-GB',

    is_franchise        BOOLEAN DEFAULT FALSE,
    is_active           BOOLEAN DEFAULT TRUE,

    created_at          TIMESTAMP DEFAULT NOW()
);

-- Per-site module toggles:
--   CALENDAR, CUSTOMER_COMMS, ADVANCED_BOOKING, SALES_OPS, PARTS_RETAIL, etc.
CREATE TABLE site_features (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    feature_key         TEXT NOT NULL,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(site_id, feature_key)
);

-- Profit centres under each site (Workshop, MOT Bay, Sales Dept, etc.)
CREATE TABLE profit_centres (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,     -- "Workshop", "MOT Bay", "Sales Dept"
    type                TEXT,              -- optional tag/category e.g. 'service', 'sales', 'rental'
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 3. ROLES / USERS / PERMISSIONS
-- ============================================================================

-- roles are defined per group (tenant). They carry a permissions JSON.
CREATE TABLE roles (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,            -- "Group Admin", "Site Admin", "Technician"
    description         TEXT,
    permissions         JSONB NOT NULL DEFAULT '{}'::jsonb, 
    -- Example permissions JSON:
    -- {
    --   "job_card:view": true,
    --   "job_card:edit": true,
    --   "reports:view": false,
    --   "admin:manage_profit_centres": false,
    --   "billing:view_status": true
    -- }
    created_at          TIMESTAMP DEFAULT NOW()
);

-- users belong to a group, usually have a "home" site, and are assigned a role
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    site_id             UUID REFERENCES sites(id) ON DELETE SET NULL,
    role_id             UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,

    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    is_active           BOOLEAN DEFAULT TRUE,

    created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 4. CUSTOMERS / VEHICLES
-- ============================================================================

CREATE TABLE customers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

    name                TEXT NOT NULL,
    phone               TEXT,
    email               TEXT,
    notes               TEXT,

    created_at          TIMESTAMP DEFAULT NOW()
);

-- Vehicles are linked to customers, not directly to job cards,
-- so one customer can own multiple vehicles.
CREATE TABLE vehicles (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    registration        TEXT NOT NULL,        -- reg / plate
    vin                 TEXT,
    make                TEXT,
    model               TEXT,
    derivative          TEXT,
    fuel_type           TEXT,
    transmission        TEXT,
    engine_code         TEXT,
    year                SMALLINT,
    mileage_at_create   INTEGER,

    created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 5. CATALOGUES (SERVICES / PARTS / TAX RATES)
-- ============================================================================

-- Standard labour / service menu.
-- Can exist at group level OR be overridden at site level.
CREATE TABLE services_catalogue (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id                    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    site_id                     UUID REFERENCES sites(id) ON DELETE CASCADE,

    service_code                TEXT,           -- e.g. 'MOT', 'FULL_SERV', 'DIAG_1HR'
    name                        TEXT NOT NULL,  -- "MOT Test", "Full Service"
    description                 TEXT,

    default_duration_minutes    INTEGER,        -- used by Calendar for slot length
    default_labour_rate         NUMERIC(10,2),  -- hourly or flat interpretation
    default_price               NUMERIC(10,2),  -- what we charge retail for this service

    vat_rate                    NUMERIC(5,2) DEFAULT 20.00, -- snapshot at creation time
    is_active                   BOOLEAN DEFAULT TRUE,

    created_at                  TIMESTAMP DEFAULT NOW()
);

-- Master parts catalogue. This underpins
-- Parts Retail and also job_card_items of type 'part'.
CREATE TABLE parts_catalogue (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,

    part_number     TEXT NOT NULL,
    description     TEXT,
    brand           TEXT,

    cost_price      NUMERIC(10,2),
    sell_price      NUMERIC(10,2),
    vat_rate        NUMERIC(5,2) DEFAULT 20.00,

    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Tax/VAT table to track historical rates so we don't assume 20% forever.
CREATE TABLE tax_rates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT,                 -- "UK VAT Standard", "MOT Zero Rate"
    percentage      NUMERIC(5,2) NOT NULL,
    valid_from      DATE NOT NULL,
    valid_to        DATE
);

-- ============================================================================
-- 6. BOOKINGS (CALENDAR-LIVE READY)
-- ============================================================================

-- Bookings represent something on the diary.
-- For MVP this feeds "today's work". Later this feeds Calendar / Advanced Booking.
CREATE TABLE bookings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    profit_centre_id    UUID NOT NULL REFERENCES profit_centres(id) ON DELETE CASCADE,

    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,

    booking_date        DATE NOT NULL,      -- high-level day anchor
    start_time          TIMESTAMP,          -- precise scheduling start
    end_time            TIMESTAMP,          -- precise scheduling end

    service_id          UUID REFERENCES services_catalogue(id) ON DELETE SET NULL,

    resource_id         UUID,               -- optional link to a "lift" / "bay" / "booth" in future
    resource_type       TEXT,               -- 'lift', 'mot_lane', 'spray_booth', etc.

    status              TEXT NOT NULL DEFAULT 'booked', 
    -- e.g. 'booked', 'in_progress', 'completed', 'cancelled'

    created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 7. JOB CARDS (THE HEART OF THE SYSTEM)
-- ============================================================================

CREATE TABLE job_cards (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id                UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    site_id                 UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    profit_centre_id        UUID NOT NULL REFERENCES profit_centres(id) ON DELETE CASCADE,

    customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    vehicle_id              UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,

    status                  TEXT NOT NULL DEFAULT 'open',
    -- 'open', 'in_progress', 'done', 'archived'

    mechanic_assigned       UUID REFERENCES users(id) ON DELETE SET NULL,

    odometer_in             INTEGER,
    odometer_out            INTEGER,

    labour_bill_numeric     NUMERIC(10,2) DEFAULT 0,  -- what we billed for labour
    labour_cost_numeric     NUMERIC(10,2) DEFAULT 0,  -- what it cost us to deliver
    parts_bill_numeric      NUMERIC(10,2) DEFAULT 0,  -- what we billed for parts
    parts_cost_numeric      NUMERIC(10,2) DEFAULT 0,  -- what those parts cost us

    completed_at            TIMESTAMP,
    archived_at             TIMESTAMP,

    signed_off_by_customer  BOOLEAN DEFAULT FALSE,
    signed_off_at           TIMESTAMP,

    created_at              TIMESTAMP DEFAULT NOW()
);

-- Photos for intake / evidence / final handover
CREATE TABLE job_card_photos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_card_id     UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

    photo_type      TEXT,                   -- 'intake_front', 'intake_left', 'damage', 'complete', etc.
    file_url        TEXT NOT NULL,

    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at     TIMESTAMP DEFAULT NOW()
);

-- Line items inside a job card.
-- This is how we attach granular charges (labour, parts, misc) + VAT snapshot.
CREATE TABLE job_card_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_card_id     UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

    item_type       TEXT NOT NULL CHECK (item_type IN ('labour','part','misc')),
    description     TEXT NOT NULL,

    qty             NUMERIC(10,2) DEFAULT 1,
    unit_cost       NUMERIC(10,2) DEFAULT 0,   -- our cost
    unit_price      NUMERIC(10,2) DEFAULT 0,   -- what we bill the customer

    vat_rate        NUMERIC(5,2) DEFAULT 20.00,
    vat_amount      NUMERIC(10,2) DEFAULT 0,

    created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 8. AUDIT LOG (RECOMMENDED FOR MVP)
-- ============================================================================

-- Tracks important actions for compliance, debugging, and accountability.
-- Example actions: job card closed, billing status changed, user deactivated, etc.
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,

    entity          TEXT NOT NULL,          -- 'job_card', 'booking', 'user', 'billing'
    entity_id       UUID NOT NULL,          -- the row affected

    action          TEXT NOT NULL,          -- 'status_change', 'edit', 'create', 'archive'
    diff_json       JSONB,                  -- what changed (before/after snapshot, optional)

    created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================

