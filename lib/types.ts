/**
 * File: lib/types.ts
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Central types. We'll expand as we hook up Postgres.
 */
export interface Booking {
  id: string;
  time: string;
  reg: string;
  vehicle: string;
  service: string;
  status: string;
  account_id?: string;
}
