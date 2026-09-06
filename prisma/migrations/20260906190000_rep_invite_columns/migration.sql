-- Rep gains the set-password invite columns Operator and the tenant User already have.
--
-- THREE, not four: a rep awaiting an invite is marked by the INVITE_PENDING sentinel in
-- passwordHash, which Rep already carries. The raw token is emailed and only its hash is stored;
-- single-use, with an expiry.
--
-- ADDED WHILE ZERO REPS EXIST. Once one does, the alternative is somebody typing a colleague's
-- password into a form. THE FLOW IS NOT BUILT — these are the columns it will need, and nothing
-- writes them yet. All nullable: NULL on all three means no invite is outstanding, either because
-- the rep set their password or because none was ever issued.
ALTER TABLE "Rep" ADD COLUMN "invite_token_hash" TEXT,
                  ADD COLUMN "invite_token_expires" TIMESTAMP(3),
                  ADD COLUMN "invite_token_used_at" TIMESTAMP(3);
