// pages/api/auth/[...nextauth].ts
// Last Edited on 2025-11-02 at 14:19 

import NextAuth, { type NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import prisma from '../../../lib/db'; // Corrected path from root
import { compare } from 'bcrypt';
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
        // This is where you retrieve the user from the database.
        if (!credentials?.email || !credentials.password) {
          throw new Error('Please enter an email and password.');
        }

        // 1. Find the user by email
        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user) {
          throw new Error('No user found with this email.');
        }

        // 2. Check if the user has a password.
        // This is a placeholder for when we add password hashing.
        // For now, let's assume we need to implement this.
        // We will add the password hash in the signup step.
        // const isPasswordValid = await compare(credentials.password, user.passwordHash);
        
        // --- TEMPORARY: Remove this once signup is built ---
        // For now, we will just check if a user exists.
        // The real check will be added in the signup step.
        if (!user) {
           throw new Error('Login failed. (Password check not yet implemented)');
        }
        
        // 3. Return the user object if login is successful
        // This user object is what gets put into the JWT and session.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role, // Pass our custom role to the session
          site_id: user.site_id,
          group_id: user.group_id,
        };
      },
    }),
    // ...add more providers here, e.g. Google, GitHub
  ],

  // --- Session Configuration ---
  session: {
    strategy: 'jwt', // Use JSON Web Tokens for sessions
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