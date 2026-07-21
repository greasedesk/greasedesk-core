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

        // ARCHIVED tenant → login blocked (SuperAdmin soft-delete). Same generic failure — never
        // reveal that the tenant was archived. Reversible: un-archiving restores login instantly.
        if (user.group_id) {
          const g = await prisma.group.findUnique({ where: { id: user.group_id }, select: { archived_at: true } });
          if (g?.archived_at) throw FAIL;
        }

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
          actorClass: 'tenant',
        };
      },
    }),

    // ── OPERATOR provider (platform staff / SAP). A SEPARATE identity table — an operator is NOT a
    // tenant User. id 'operator'; the /superadmin/login page calls signIn('operator', …). Carries
    // actorClass='operator' + role + regions so the operator guards can enforce role and region. ──
    CredentialsProvider({
      id: 'operator',
      name: 'Operator',
      credentials: { email: { label: 'Email', type: 'text' }, password: { label: 'Password', type: 'password' } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) throw new Error('Please enter an email and password.');
        const FAIL = new Error('Invalid email or password.');
        const op = await prisma.operator.findUnique({ where: { email: credentials.email } });
        if (!op || op.status !== 'active') throw FAIL;           // suspended operators cannot log in
        if (!op.passwordHash || !(await bcrypt.compare(credentials.password, op.passwordHash))) throw FAIL;
        return { id: op.id, email: op.email, name: op.name, actorClass: 'operator', operatorRole: op.role, regions: op.regions } as any;
      },
    }),

    // ── REP provider (field sales PWA). A SEPARATE identity table — a rep belongs to no garage.
    // id 'rep'; /rep/login calls signIn('rep', …). Carries actorClass='rep' + repId. ──
    CredentialsProvider({
      id: 'rep',
      name: 'Rep',
      credentials: { email: { label: 'Email', type: 'text' }, password: { label: 'Password', type: 'password' } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) throw new Error('Please enter an email and password.');
        const FAIL = new Error('Invalid email or password.');
        const rep = await prisma.rep.findUnique({ where: { email: credentials.email } });
        if (!rep || rep.status !== 'active') throw FAIL;
        if (!rep.passwordHash || !(await bcrypt.compare(credentials.password, rep.passwordHash))) throw FAIL;
        return { id: rep.id, email: rep.email, name: rep.name, actorClass: 'rep', repId: rep.id } as any;
      },
    }),
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
      // REVOKED TOKEN → user-less session. The jwt callback strips the token to {} when the session
      // predates a password reset; without this the default session would still carry name/email and
      // read as signed in. Every guard checks user?.id, so a user-less session fails closed.
      if (!token?.id) return { ...session, user: undefined } as any;
      // Send properties to the client, like the user's ID and role.
      // This makes `session.user.role` available in your React components.
      if (token && session.user) {
        session.user.id = token.id as string;
        const cls = (token.actorClass ?? 'tenant') as 'tenant' | 'operator' | 'rep';
        session.user.actorClass = cls;
        if (cls === 'operator') {
          (session.user as any).operatorRole = token.operatorRole;
          (session.user as any).regions = token.regions ?? [];
        } else if (cls === 'rep') {
          (session.user as any).repId = token.repId;
        } else {
          // TENANT — unchanged shape (existing consumers read these three).
          session.user.role = token.role as UserRole;
          session.user.site_id = token.site_id as string;
          session.user.group_id = token.group_id as string;
        }
      }
      return session;
    },
    async jwt({ token, user }) {
      // This is called first, *then* the session callback.
      // We pass the user's custom data (like role) into the token.
      if (user) {
        token.id = user.id;
        // actorClass discriminates the three classes. Absent (an object shaped by an older tenant
        // authorize) → 'tenant'. Only the matching class's claims are carried.
        const cls = ((user as any).actorClass ?? 'tenant') as 'tenant' | 'operator' | 'rep';
        token.actorClass = cls;
        if (cls === 'operator') {
          token.operatorRole = (user as any).operatorRole;
          token.regions = (user as any).regions ?? [];
        } else if (cls === 'rep') {
          token.repId = (user as any).repId;
        } else {
          token.role = (user as any).role; // 'user' object is shaped by 'authorize'
          token.site_id = (user as any).site_id;
          token.group_id = (user as any).group_id;
        }
        // OUR OWN issued-at, stamped once at sign-in and carried through every rolling re-issue.
        // Deliberately NOT NextAuth's `iat`: v4 does not reliably expose it to this callback, and a
        // silently-absent value made the revocation below a no-op (caught by the live-session probe).
        token.authAt = Date.now();
      }
      // Everything below is TENANT-only session hygiene (revocation floor + stale-JWT site backfill).
      // Operators and reps have neither a User row nor a group_id, so these must not run for them —
      // absent actorClass = tenant (existing live tenant tokens carry no actorClass).
      const tokenClass = (token.actorClass ?? 'tenant') as 'tenant' | 'operator' | 'rep';
      if (tokenClass !== 'tenant') return token;

      // ── SESSION REVOCATION (the ONLY server-side kill switch) ──────────────────────────────
      // strategy:'jwt' means the cookie is SELF-CONTAINED: it cannot be revoked by deleting rows
      // (the Session table is vestigial here), so without this a stolen 90-day /m session would
      // outlive a password reset by up to three months. A reset stamps User.sessions_valid_from;
      // any token minted BEFORE that instant is dead. FAILS CLOSED: a token with no authAt (minted
      // before this shipped) is also killed once a floor exists. Returning an empty token strips
      // `id`, and the session callback below then yields a user-less session, so every guard 401s.
      if (!user && token.id) {
        const u = await prisma.user.findUnique({ where: { id: token.id as string }, select: { sessions_valid_from: true } });
        const floor = u?.sessions_valid_from ? new Date(u.sessions_valid_from).getTime() : 0;
        if (floor) {
          const authAt = typeof token.authAt === 'number' ? token.authAt : 0;
          if (!authAt || authAt < floor) return {} as any; // revoked — signed out everywhere
        }
      }
      // Stale-JWT backfill (item-13): a tenant that finishes onboarding AFTER this token was minted
      // (the site is created mid-session, at the onboarding site step) has group_id but no site_id,
      // and site_id is otherwise only stamped at login. Re-read it ONCE from the DB the moment it
      // exists, so site-scoped pages/APIs work in the first session without a re-login. Self-limiting:
      // fires only while site_id is absent, then never again. This retires the stale-JWT root cause
      // the old setup-location leaf pages were papering over.
      if (token.id && token.group_id && !token.site_id) {
        const u = await prisma.user.findUnique({ where: { id: token.id as string }, select: { site_id: true, primary_site_id: true } });
        const sid = u?.primary_site_id ?? u?.site_id ?? null;
        if (sid) token.site_id = sid;
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