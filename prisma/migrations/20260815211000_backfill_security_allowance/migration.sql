-- CORRECTION. The previous migration added counts_to_allowance DEFAULT true and its comment claimed
-- no customer SMS had ever been sent. That was wrong twice over: ten SMS rows already existed, and
-- eight of them are `phone_verify` — a SECURITY template, which by rule neither counts against a
-- garage's allowance nor can be refused by it. Left as `true` they would have silently spent six of
-- ZZ's hundred and one each of two other tenants' before a single customer message was sent.
--
-- The template list is hardcoded here rather than read from lib/notification-templates, and that is
-- correct for a one-off historical correction: this is a snapshot of which templates were security
-- ON THIS DATE. Going forward the flag is frozen at send time by lib/notify, from the registry.
UPDATE "NotificationLog"
   SET "counts_to_allowance" = false
 WHERE "channel" = 'sms'
   AND "template" IN ('phone_verify', 'login_code', 'password_reset', 'two_factor');
