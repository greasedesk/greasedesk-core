/**
 * File: lib/db.ts
 * Last edited: 2025-11-02 at 17:21
 *
 * This file initializes the real Prisma Client for the entire application.
 * It uses a "singleton" pattern to prevent multiple instances
 * of Prisma Client from being created in the development environment
 * due to Next.js's hot-reloading.
 */
import { PrismaClient } from '@prisma/client';

// We declare a global variable to hold the Prisma instance.
// We have to cast 'globalThis' to 'any' to attach our custom property.
const globalForPrisma = globalThis as any;

// Check if prisma is already attached to the global object.
// If not, create a new instance and attach it.
// This is crucial for Next.js hot-reloading.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Optional: uncomment the line below to see your database queries in the terminal
    // log: ['query'],
  });

// Export it as the default, which is what our API routes expect.
export default prisma;

// In development, attach prisma to the global object...
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}