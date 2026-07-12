// pages/api/auth/[...nextauth].ts
// Last Edited on 2025-11-13 at 12:05 (FIXED) 

import NextAuth, { type NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
// 💥 FIX: Changed to a named import to resolve the TypeScript/build error.
import { prisma } from '../../../lib/db';
import * as bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client'; // Import the Role enum

export const authOptions: NextAuthOptions = {
  // Use the Prisma Adapter
  adapter: PrismaAdapter(prisma),

  // Configure one or more authentication providers
  providers: [
    CredentialsProvider({
      // The name to display on the sign in form (e.g. "Sign in with...")
      name: 'Credentials',
      // The credentials is used to generate a suitable form on the sign in page.
      credentials: {
        email: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' },
      
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) {
          throw new Error('Please enter an email and password.');
        }

        // One generic failure for every auth-failure reason — never reveal which check failed
        // (no-such-email and wrong-password must be indistinguishable to the client).
        const FAIL = new Error('Invalid email or password.');

        const user = await prisma.user.findUnique({ where: { email: credentials.email } });
        if (!user) throw FAIL;

        // No usable password hash yet (never set, or still the invite placeholder) → cannot log in.
        if (!user.passwordHash || user.passwordHash === 'INVITE_PENDING') throw FAIL;

        // Inactive accounts cannot log in.
        if (!user.is_active) throw FAIL;

        // Verify the supplied password against the stored bcrypt hash.
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) throw FAIL;

        // Returned object is put into the JWT / session.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          // Land on the admin-set primary site; fall back to the user's home site.
          site_id: user.primary_site_id ?? user.site_id,
          group_id: user.group_id,
        };
      },
    }),
    // ...add more providers here, e.g. Google, GitHub
  ],

  // --- Session Configuration ---
  session: {
    strategy: 'jwt', // Use JSON Web Tokens for sessions
    // 90 days, ROLLING (JWT-strategy cookies re-issue on every session touch): a mechanic who
    // opens the phone app once a month never re-authenticates. DELIBERATE TRADE-OFF (ruling
    // 2026-07-12): one auth chokepoint, one cookie — this widens the DESKTOP session to 90 days
    // too. Scoping a longer lifetime to /m alone would need a second cookie or a parallel auth
    // surface, which is exactly what the one-chokepoint rule forbids.
    maxAge: 90 * 24 * 60 * 60,
  },

  // --- Callbacks ---
  // Callbacks are used to control what happens when an action is performed.
  callbacks: {
    async session({ session, token }) {
      // Send properties to the client, like the user's ID and role.
      // This makes `session.user.role` available in your React components.
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as UserRole;
        session.user.site_id = token.site_id as string;
        session.user.group_id = token.group_id as string;
      }
      return session;
    },
    async jwt({ token, user }) {
      // This is called first, *then* the session callback.
      // We pass the user's custom data (like role) into the token.
      if (user) {
        token.id = user.id;
        token.role = (user as any).role; // 'user' object is shaped by 'authorize'
        token.site_id = (user as any).site_id;
        token.group_id = (user as any).group_id;
      }
      return token;
    },
  },

  // --- Secret ---
  // A secret is required for JWT.
  secret: process.env.NEXTAUTH_SECRET,

  // --- Pages ---
  // We will create these pages soon.
  pages: {
    signIn: '/admin/login', // Your new admin login page
    // We can add a customer sign-in page later
    // signIn: '/login', 
  },
};

export default NextAuth(authOptions);