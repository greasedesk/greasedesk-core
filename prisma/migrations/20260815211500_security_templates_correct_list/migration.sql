-- The previous correction guessed the security template names and got two of four wrong: it listed
-- 'login_code' and 'two_factor', neither of which exists, and MISSED 'demo_expiring' and
-- 'signup_verify'. On today's data that made no difference — the only security SMS ever sent were
-- phone_verify — so the gate passed and the mistake was invisible in the result.
--
-- It is corrected rather than left because migrations are REPLAYED. A database built from scratch
-- runs the wrong list, and the first tenant to receive a demo_expiring or signup_verify text would
-- be charged for their own account notification.
--
-- The list is the registry as at 2026-08-15 (lib/notification-templates, `security: true`). Going
-- forward nothing depends on it: lib/notify freezes counts_to_allowance at send time.
UPDATE "NotificationLog"
   SET "counts_to_allowance" = false
 WHERE "channel" = 'sms'
   AND "template" IN ('phone_verify', 'demo_expiring', 'signup_verify', 'password_reset');
