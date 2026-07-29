-- Setup wizard (ruling 2026-07-29): 'other' bookable resources + operator-editable step definitions.
-- PG12+: ADD VALUE is transaction-safe as long as the new value is not used in the same transaction.
ALTER TYPE "ResourceType" ADD VALUE IF NOT EXISTS 'other';

CREATE TABLE "SetupStepDef" (
  "id" TEXT NOT NULL,
  "step_key" TEXT NOT NULL,
  "handler_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "help_text" TEXT NOT NULL DEFAULT '',
  "position" INTEGER NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "countries" JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SetupStepDef_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SetupStepDef_step_key_key" ON "SetupStepDef"("step_key");

-- Seed the six launch steps (operator edits from here on; wording interpolates profile tokens).
INSERT INTO "SetupStepDef" ("id", "step_key", "handler_key", "title", "body", "help_text", "position", "required", "enabled", "countries") VALUES
 ('11111111-0000-4000-8000-000000000001', 'lifts',       'resources_lifts',  'How many lifts in your workshop?', 'Each lift becomes a bookable column in your diary.', 'You can rename them later under Settings → Locations & Resources.', 10, true,  true, NULL),
 ('11111111-0000-4000-8000-000000000002', 'booths',      'resources_booths', 'How many spray booths?', 'Booths appear alongside lifts in the diary.', 'Skip if you have none.', 20, false, true, NULL),
 ('11111111-0000-4000-8000-000000000003', 'other_res',   'resources_other',  'Any other bookable revenue resources?', 'Rolling road, {{testName}} bay, wash bay — anything you book work onto.', 'Add each with its own name.', 30, false, true, NULL),
 ('11111111-0000-4000-8000-000000000004', 'technicians', 'technicians',      'How many technicians — including yourself if you work on the floor?', 'Each technician needs their contracted hours so your capacity and utilisation figures are real. Salary stays private to admins.', 'Add at least one; more can be added later under HR.', 40, true,  true, NULL),
 ('11111111-0000-4000-8000-000000000005', 'costs',       'overheads_basic',  'Basic costs', 'Rent, property taxes, utilities — the fixed costs behind your monthly break-even ({{currencySymbol}}, ex {{taxLabel}}).', 'At least one; refine later under Settings → Overheads.', 50, true,  true, NULL),
 ('11111111-0000-4000-8000-000000000006', 'contact',     'contact_details',  'Company phone and WhatsApp', 'Shown to customers on quotes ({{phonePlaceholder}}).', 'Optional — skip and add later.', 60, false, true, NULL);
