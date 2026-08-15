-- What a connected account can actually take, mirrored from Stripe's capabilities map.
-- Additive and nullable: NULL means never synced, which is true of every row until the next
-- account.updated webhook or Payments-page resync writes one.
ALTER TABLE "ProviderConnection" ADD COLUMN "capabilities" JSONB;
