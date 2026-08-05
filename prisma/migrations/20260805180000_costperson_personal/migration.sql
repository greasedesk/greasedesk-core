-- Optional personal details on the employee record. ADDITIVE ONLY, every column nullable — an
-- existing person has none of them and must stay valid, and nothing may default to a value the
-- person did not choose.
ALTER TABLE "CostPerson" ADD COLUMN "date_of_birth" DATE;
ALTER TABLE "CostPerson" ADD COLUMN "home_address" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "personal_email" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "personal_phone" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "emergency_contact_name" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "emergency_contact_relationship" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "emergency_contact_phone" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "gender" TEXT;
ALTER TABLE "CostPerson" ADD COLUMN "pronouns" TEXT;
