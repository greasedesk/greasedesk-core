-- Marketing settings, per tenant. The board is per-tenant (buildBoard takes a groupId and scopes
-- nothing by site), so these belong on Group and on an adminOnly Settings tab — not inline on
-- Locations, where the SITE-scoped intake prompts live.
--
-- TWO OF THE THREE ARE NULLABLE ON PURPOSE. Writing the platform default into every tenant at
-- migration time would make "the garage chose 30" and "nobody has been asked" identical for ever —
-- the same argument as mot_checked_at and the empty mileage-out box. Null lets the fallback move
-- later without silently overriding a garage that deliberately picked the same number.
--
-- The boolean is NOT nullable, and that is the same argument from the other side: it has two
-- states, and a third would only ever mean "we forgot to write it".
ALTER TABLE "Group" ADD COLUMN "marketing_expired_quotes" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Group" ADD COLUMN "marketing_snooze_days" INTEGER;
ALTER TABLE "Group" ADD COLUMN "marketing_quote_hot_days" INTEGER;
