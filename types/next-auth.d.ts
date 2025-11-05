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
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      site_id: string;
      group_id: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: UserRole;
    site_id: string;
    group_id: string;
  }
}