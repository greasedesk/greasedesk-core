/**
 * File: schema.sql
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * These are the Postgres tables we'll create in Neon/Supabase.
 * Every table has account_id for multi-tenant isolation.
 */

-- Garages / tenants
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  garage_name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  vat_number TEXT,
  labour_rate_numeric NUMERIC(10,2),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Users that can log in
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','mechanic','service_advisor')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Known vehicles in that garage
CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  reg TEXT NOT NULL,
  make TEXT,
  model TEXT,
  variant TEXT,
  vin TEXT,
  mileage_last_seen INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Menu of services / pricing
CREATE TABLE services_catalogue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  description TEXT,
  est_duration_minutes INTEGER,
  retail_price_inc_vat NUMERIC(10,2),
  cost_parts_total NUMERIC(10,2),
  cost_labour_calc NUMERIC(10,2),
  servicing_tier INTEGER, -- 1..5
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bookings (customer + slot on calendar)
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  service_id TEXT NOT NULL REFERENCES services_catalogue(id),
  booking_start TIMESTAMP NOT NULL,
  booking_end TIMESTAMP NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('booked','in_progress','completed','collected','cancelled')
  ),
  customer_name TEXT,
  customer_mobile TEXT,
  notes_from_customer TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Job card
CREATE TABLE job_cards (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  checklist_json JSONB,
  intake_complete BOOLEAN DEFAULT FALSE,
  completion_complete BOOLEAN DEFAULT FALSE,
  technician_notes TEXT,
  advisor_notes_for_customer TEXT,
  ready_to_collect BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Photos for intake / completion
CREATE TABLE job_card_photos (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_card_id TEXT NOT NULL REFERENCES job_cards(id),
  slot TEXT NOT NULL, -- 'front','left','rear','right','engine_bay','vin','mileage','other'
  url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
