/**
 * File: types/next-auth.d.ts
 * Last edited: 2025-11-05 13:50 Europe/London 
 *
 * Extends NextAuth types (Session and JWT) to include custom user properties 
 * from the database (id, role, site_id, group_id).
 */

import 'next-auth';
import { DefaultSession, DefaultUser } from 'next-auth';
import { JWT } from 'next-auth/jwt';
import { UserRole } from '@prisma/client';

// Extend the built-in session and JWT types
// actorClass discriminates the three authenticated classes (layer 1 of the platform tier). Tenant
// tokens minted before this shipped carry NO actorClass — every reader treats absent as 'tenant',
// so existing sessions are unchanged. Operator/rep claims are only present on their own classes.
type ActorClass = 'tenant' | 'operator' | 'rep';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      site_id: string;
      group_id: string;
      actorClass?: ActorClass;
      operatorRole?: 'owner' | 'country_manager' | 'support';
      regions?: string[];
      repId?: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: UserRole;
    site_id: string;
    group_id: string;
    actorClass?: ActorClass;
    operatorRole?: 'owner' | 'country_manager' | 'support';
    regions?: string[];
    repId?: string;
    /** OUR issued-at (ms), stamped at sign-in. Compared against User.sessions_valid_from to revoke
     *  sessions that predate a password reset. Optional: tokens minted before this shipped lack it,
     *  and the revocation check treats a missing value as "too old" (fails closed). */
    authAt?: number;
  }
}