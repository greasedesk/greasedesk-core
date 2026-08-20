-- HOW THE CONTACT WENT OUT — a property of the contact, not a fifth state.
--
-- `contacted` is an OUTCOME, alongside booked/declined/snoozed. The channel is how it happened.
-- Making "texted" its own state would force a garage to choose between two words for one fact —
-- a car that was texted IS contacted — and would then need answering everywhere the four states
-- are read.
--
-- NULLABLE, and the null is meaningful rather than lazy: every contact recorded before this
-- column existed went out by a means we never asked about, and a phone call recorded through the
-- Contacted button still does. NULL = "we do not know how", which is the truth for those rows.
-- Only a SEND writes it, so a non-null value always means GreaseDesk sent the message itself.
ALTER TABLE "MarketingContact" ADD COLUMN "channel" TEXT;

-- The value set is fixed at the database, not by convention: 'sms', 'email', or 'both' when one
-- press sent by two routes. A constraint rather than an enum because this is a small closed set
-- that the send path owns, and adding a value should be a migration someone reads.
ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_channel_check"
  CHECK ("channel" IS NULL OR "channel" IN ('sms', 'email', 'both'));
