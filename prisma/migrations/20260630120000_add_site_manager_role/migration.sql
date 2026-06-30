-- Hand-written safe migration: add SITE_MANAGER to UserRole, between ADMIN and STANDARD.
-- Existing values are preserved (ADMIN→ADMIN, STANDARD→STANDARD). No row becomes SITE_MANAGER.
-- Additive / non-destructive (Prisma's auto enum edit can mishandle the in-place type swap).
CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'SITE_MANAGER', 'STANDARD');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new"
  USING ("role"::text::"UserRole_new");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'STANDARD';
DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
