-- Hand-written safe migration (Prisma's auto enum-value removal would fail on existing data).

-- 1) Owner flag (additive; existing rows → false)
ALTER TABLE "User" ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT false;

-- 2) Rebuild UserRole {STAFF,CUSTOMER} → {ADMIN,STANDARD}, mapping existing values safely.
CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'STANDARD');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new"
  USING (CASE "role"::text WHEN 'ADMIN' THEN 'ADMIN' ELSE 'STANDARD' END::"UserRole_new");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'STANDARD';
DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
