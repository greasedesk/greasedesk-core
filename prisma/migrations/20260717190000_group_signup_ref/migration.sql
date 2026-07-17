-- Marketing attribution captured at signup from a public ?ref= parameter (dormant — no rep system
-- yet). Additive + nullable: existing groups stay null. Never lost, cheap to add now.
ALTER TABLE "Group" ADD COLUMN "signup_ref" TEXT;
