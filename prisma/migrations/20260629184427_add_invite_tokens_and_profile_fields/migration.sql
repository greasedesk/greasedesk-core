-- AlterTable
ALTER TABLE "Group" ALTER COLUMN "ref" SET DEFAULT ('GB-GD' || nextval('group_ref_seq'::regclass));

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "certifications" TEXT,
ADD COLUMN     "driving_licence_categories" TEXT,
ADD COLUMN     "emergency_note" TEXT,
ADD COLUMN     "invite_token_expires" TIMESTAMP(3),
ADD COLUMN     "invite_token_hash" TEXT,
ADD COLUMN     "invite_token_used_at" TIMESTAMP(3),
ADD COLUMN     "job_title" TEXT,
ADD COLUMN     "next_of_kin_name" TEXT,
ADD COLUMN     "next_of_kin_phone" TEXT,
ADD COLUMN     "next_of_kin_relationship" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "start_date" DATE,
ADD COLUMN     "working_hours" TEXT;
