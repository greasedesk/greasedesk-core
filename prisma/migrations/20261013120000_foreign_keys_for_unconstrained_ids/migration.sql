-- @migration: constraining  adds 37 foreign keys to columns that had none
-- @applied-ahead-of-deploy: 2026-10-13T17:17:59.480Z
--   production was running: 81d861ee9c0ba7e74ad10e3ba06d689c7d5abbea
--   this tree: 1687a09b41f28908e572ce52eb907453c2cae363
--   app files not live at the time: lib/audit.ts, lib/tenant-manifest.ts, lib/tenant-purge.ts, scripts/fk-constraints-plan.mjs, scripts/migration-class-gate.mjs, scripts/purge-completeness-gate.mjs, scripts/repair-fk-orphans-2026-10-13.mjs, scripts/schema-drift-gate.mjs
--   reason given: DEADLOCK confirmed 2026-10-13: the Vercel production build runs prisma migrate status and exits 1 while this migration is pending, so 2ac39bd cannot deploy until it is applied; this script refuses until production reports 2ac39bd. Applying first is the order this migration's own note already states for the inverted case: no deployed writer is constrained by these 37 keys (every column verified orphan-free first), and the code that DEPENDS on them is not live precisely because the build is failing. Owner's instruction, after confirming the chain.
--   Applied with --even-if-not-live. Until the push landed, production ran code that did not
--   satisfy this migration. If something broke in that window, this is the window.
--
-- WHAT THIS IS FOR, because the next person to read it will ask.
--
-- NOTHING TOLD THE VS1 DELETER THERE WERE THREE BACK-REFERENCES. A repair script on 2026-10-11
-- deleted a stock item, cascaded StockDisposal, nulled Invoice.stock_disposal_id — and missed
-- JobCard.sale_of_stock_item_id, which then dangled for two days until an FK audit found it. It
-- was not careless: it cleaned up every reference its author knew about. There was no list, and
-- the database held no opinion. A foreign key would have REFUSED the delete instead of accepting
-- a lie. That is the case for this migration in one sentence; it is not tidiness.
--
-- SCOPE. 81 unconstrained *_id columns exist (78 at the previous audit, which is why the set is
-- re-derived by scripts/fk-constraints-plan.mjs rather than carried in a list). Of those:
--   37  constrained here
--   37  must NEVER be constrained — external ids (Stripe, Svix, Resend, OAuth), polymorphic
--       columns (subject_id, entity_id, the party_id/party_type pairs), two that are not
--       references at all (ConsentEvent.consent_id is the browser's cookie uuid;
--       LeaveRecord.leave_batch_id is a grouping key), records that must OUTLIVE their subject
--       (SuperAdminAudit.target_group_id has 445 orphans across 425 groups, every one explained
--       by a tenant.purged row in that same table — an FK would block the purge or delete its own
--       evidence), the OURS_PER_TENANT records that deliberately survive a purge
--       (CommissionEntry, TenantAttribution, RepVisit), and seven columns whose NO ACTION would
--       break the atomic tenant purge at tx.user.deleteMany.
--    4  pending the owner's decision (they had orphans)
--    3  unresolved targets, deliberately not guessed
--
-- ON DELETE follows the schema's own convention: Cascade to Group (57 of 61 existing FKs to it),
-- SetNull where the column is nullable, NO ACTION where it is NOT NULL. Never Restrict: NO ACTION
-- is deferred to end-of-statement, so a cascading purge that removes parent and child in ONE
-- statement still succeeds, where Restrict would fail immediately.
--
-- ORDER OF DEPLOY. This is the inverse of the usual constraining case. No deployed writer is
-- constrained by these keys — every column was verified orphan-free first. What DEPENDS on them
-- is the next push, which removes three now-redundant explicit deletes from lib/tenant-purge
-- (uploadTelemetry, vinReadShadow, stockNumberSequence, each commented "no FK — cascade misses").
-- So this migration must be applied BEFORE that code is live, never after: the old purge running
-- against the new keys merely deletes rows that would have cascaded anyway, while the new purge
-- running without the keys would silently leave tenant rows behind.

-- AddForeignKey
ALTER TABLE "UploadTelemetry" ADD CONSTRAINT "UploadTelemetry_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadTelemetry" ADD CONSTRAINT "UploadTelemetry_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_primary_site_id_fkey" FOREIGN KEY ("primary_site_id") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_service_catalogue_id_fkey" FOREIGN KEY ("service_catalogue_id") REFERENCES "ServiceCatalogue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "StockItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCardPhoto" ADD CONSTRAINT "JobCardPhoto_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCardItem" ADD CONSTRAINT "JobCardItem_option_draft_id_fkey" FOREIGN KEY ("option_draft_id") REFERENCES "QuoteOptionDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_stock_disposal_id_fkey" FOREIGN KEY ("stock_disposal_id") REFERENCES "StockDisposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_catalogue_item_id_fkey" FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinReadShadow" ADD CONSTRAINT "VinReadShadow_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinReadShadow" ADD CONSTRAINT "VinReadShadow_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinReadShadow" ADD CONSTRAINT "VinReadShadow_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "JobCardPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_fee_rate_id_fkey" FOREIGN KEY ("fee_rate_id") REFERENCES "ApplicationFeeRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedInvoice" ADD CONSTRAINT "StagedInvoice_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedInvoice" ADD CONSTRAINT "StagedInvoice_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedInvoice" ADD CONSTRAINT "StagedInvoice_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedInvoice" ADD CONSTRAINT "StagedInvoice_planned_resource_id_fkey" FOREIGN KEY ("planned_resource_id") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedLine" ADD CONSTRAINT "StagedLine_catalogue_item_id_fkey" FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_magic_link_id_fkey" FOREIGN KEY ("magic_link_id") REFERENCES "CustomerMagicLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteVersionLine" ADD CONSTRAINT "QuoteVersionLine_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "QuoteOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_consent_by_rep_id_fkey" FOREIGN KEY ("consent_by_rep_id") REFERENCES "Rep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_created_by_rep_id_fkey" FOREIGN KEY ("created_by_rep_id") REFERENCES "Rep"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_signed_up_group_id_fkey" FOREIGN KEY ("signed_up_group_id") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectVisit" ADD CONSTRAINT "ProspectVisit_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "Rep"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobClockSession" ADD CONSTRAINT "JobClockSession_corrected_by_user_id_fkey" FOREIGN KEY ("corrected_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobClockSession" ADD CONSTRAINT "JobClockSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseModel" ADD CONSTRAINT "PurchaseModel_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_reacquired_from_disposal_id_fkey" FOREIGN KEY ("reacquired_from_disposal_id") REFERENCES "StockDisposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDisposal" ADD CONSTRAINT "StockDisposal_buyer_customer_id_fkey" FOREIGN KEY ("buyer_customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNumberSequence" ADD CONSTRAINT "StockNumberSequence_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCost" ADD CONSTRAINT "StockCost_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "StockCost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCostSnapshot" ADD CONSTRAINT "StockCostSnapshot_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

