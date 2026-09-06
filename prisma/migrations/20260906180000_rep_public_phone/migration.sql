-- Rep gains a published contact number, stored in both forms.
--
-- `phone` is what a person typed; `phone_e164` is the dialable form derived from it at the write
-- (lib/tenant-rep::repPhoneFields, the same derivation customerPhoneFields performs). A published
-- number is a number that gets dialled, so it is stored dialable rather than reformatted at render.
--
-- BOTH NULLABLE. A rep who has not published a number is an ordinary state: the support page omits
-- the line rather than printing a placeholder, and renders no `tel:` link. phone_e164 is
-- additionally null when what was typed cannot be resolved — honest-null, in step with
-- Customer.phone_e164: an unresolvable number is still shown to a human, it just is not a link.
ALTER TABLE "Rep" ADD COLUMN "phone" TEXT,
                  ADD COLUMN "phone_e164" TEXT;
