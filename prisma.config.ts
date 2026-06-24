/**
 * File: prisma.config.ts
 * Last edited: 2025-11-18 16:35 Europe/London
 *
 * Prisma CLI configuration.
 * - Removes deprecated `package.json#prisma` usage.
 * - Keeps your existing JS seed script at prisma/seed.js.
 */

import { defineConfig } from 'prisma/config';
// Prisma stops auto-loading .env once this config file exists, so load it
// ourselves. Without this, every Prisma CLI command (db push, migrate, seed)
// fails with "Environment variable not found: DATABASE_URL".
import 'dotenv/config';

export default defineConfig({
  // We’re using the default schema path: "prisma/schema.prisma"
  // If you ever move it, you can add: schema: 'path/to/schema.prisma'

  migrations: {
    // Default migrations folder is "prisma/migrations" so no need to set `path`.
    // Tell Prisma how to seed the DB (equivalent to the old package.json "prisma.seed").
    seed: 'node prisma/seed.js',
  },
});
