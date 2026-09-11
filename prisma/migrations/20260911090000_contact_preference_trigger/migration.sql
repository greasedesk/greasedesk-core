-- A CONTACT PREFERENCE WITHOUT ITS HISTORY CANNOT BE COMMITTED.
--
-- Hand-written, applied with `migrate deploy`.
--
-- ── THE FIRST TRIGGER IN THIS SCHEMA, AND WHY IT IS ONE ────────────────────────────────────────
-- Every other rule here is a CHECK, a foreign key or a unique index: something about ONE row. This
-- one is about TWO tables agreeing — a Customer's preference column and the latest
-- ContactPreferenceEvent for it — and no declarative constraint can say that. So it is a trigger,
-- and the first. That is a reason for care, not a reason against (owner, 2026-09-11):
--
--   The history is the record a garage produces when challenged. A preference with no history is
--   not a defect to find later — it is the thing that had to be right. contact-preferences-gate's
--   cross-check FINDS a column that moved without its event, after the fact; this PREVENTS it.
--   lib/contact-preferences is the one writer by convention; this makes it the one writer by
--   construction — against a future caller, a script, a seed, or raw SQL alike.
--
-- ── WHAT IT HOLDS ──────────────────────────────────────────────────────────────────────────────
-- At COMMIT, for any customer whose preference columns were written (or whose history grew) in the
-- transaction: each of the four columns equals the opted_out of its latest event (highest seq), or
-- is NULL with no event at all. Anything else rolls the whole transaction back.
--
-- DEFERRED TO COMMIT because the writer moves the column and THEN appends the event, in one
-- transaction; checked at the statement, the column would always be one step ahead of its history.
-- It RE-READS the rows at commit rather than trusting NEW, which is only the row as that one
-- statement left it — a later statement in the same transaction may have moved it again.
--
-- ── ONE FUNCTION, THREE TRIGGERS ───────────────────────────────────────────────────────────────
--   Customer, after a preference column CHANGES (or a customer is created with one set)
--   ContactPreferenceEvent, after an insert — history that disagrees with the column is the same
--     broken record from the other side
--   ContactPreferenceEvent, before an UPDATE — the history is append-only, now by construction.
--     DELETE is not blocked: rows leave only with their customer or tenant (cascade and purge).
--
-- ── WHAT IT COSTS ──────────────────────────────────────────────────────────────────────────────
-- Nothing on the paths that do not touch preferences: the Customer triggers carry WHEN clauses, so
-- an address edit, a bulk import of customers with no preference, or the demo generator never
-- call the function. When it does run, it is four index lookups on
-- (customer_id, channel, scope, created_at) for the one customer.

CREATE OR REPLACE FUNCTION contact_preference_mismatch(cid TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
  r RECORD;
  latest BOOLEAN;
BEGIN
  SELECT email_opt_out, sms_opt_out, email_marketing_opt_out, sms_marketing_opt_out INTO c
    FROM "Customer" WHERE id = cid;
  IF NOT FOUND THEN
    RETURN NULL; -- deleted later in the same transaction: there is nothing left to hold
  END IF;
  FOR r IN SELECT * FROM (VALUES ('email', 'all', c.email_opt_out), ('sms', 'all', c.sms_opt_out),
                                 ('email', 'marketing', c.email_marketing_opt_out),
                                 ('sms', 'marketing', c.sms_marketing_opt_out)) AS v(channel, scope, colval)
  LOOP
    SELECT e.opted_out INTO latest FROM "ContactPreferenceEvent" e
      WHERE e.customer_id = cid AND e.channel = r.channel AND e.scope = r.scope
      ORDER BY e.seq DESC LIMIT 1;
    IF NOT FOUND THEN
      IF r.colval IS NOT NULL THEN
        RETURN format('%s/%s is %s with no history at all', r.channel, r.scope, r.colval::text);
      END IF;
    ELSIF latest IS DISTINCT FROM r.colval THEN
      RETURN format('%s/%s is %s but its latest event says %s', r.channel, r.scope,
                    coalesce(r.colval::text, 'no record'), coalesce(latest::text, 'no record'));
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION contact_preference_history_trg() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  cid TEXT;
  m TEXT;
BEGIN
  -- Two statements, not one CASE: PL/pgSQL plans a whole expression, and NEW.customer_id does not
  -- exist on a Customer row. Each branch below is planned only when it runs.
  IF TG_TABLE_NAME = 'Customer' THEN
    cid := NEW.id;
  ELSE
    cid := NEW.customer_id;
  END IF;
  m := contact_preference_mismatch(cid);
  IF m IS NOT NULL THEN
    RAISE EXCEPTION 'contact preference on customer % disagrees with its history: % — every change goes through lib/contact-preferences', cid, m
      USING ERRCODE = '23514', CONSTRAINT = 'Customer_contact_preference_history';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION contact_preference_event_append_only_trg() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ContactPreferenceEvent % is append-only — a recorded change is never edited; record a new one', OLD.id
    USING ERRCODE = '23514', CONSTRAINT = 'ContactPreferenceEvent_append_only';
END $$;

CREATE CONSTRAINT TRIGGER "Customer_contact_preference_history_upd"
  AFTER UPDATE OF email_opt_out, sms_opt_out, email_marketing_opt_out, sms_marketing_opt_out ON "Customer"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.email_opt_out IS DISTINCT FROM NEW.email_opt_out OR OLD.sms_opt_out IS DISTINCT FROM NEW.sms_opt_out
        OR OLD.email_marketing_opt_out IS DISTINCT FROM NEW.email_marketing_opt_out
        OR OLD.sms_marketing_opt_out IS DISTINCT FROM NEW.sms_marketing_opt_out)
  EXECUTE FUNCTION contact_preference_history_trg();

CREATE CONSTRAINT TRIGGER "Customer_contact_preference_history_ins"
  AFTER INSERT ON "Customer"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.email_opt_out IS NOT NULL OR NEW.sms_opt_out IS NOT NULL
        OR NEW.email_marketing_opt_out IS NOT NULL OR NEW.sms_marketing_opt_out IS NOT NULL)
  EXECUTE FUNCTION contact_preference_history_trg();

CREATE CONSTRAINT TRIGGER "ContactPreferenceEvent_matches_customer"
  AFTER INSERT ON "ContactPreferenceEvent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION contact_preference_history_trg();

CREATE TRIGGER "ContactPreferenceEvent_append_only"
  BEFORE UPDATE ON "ContactPreferenceEvent"
  FOR EACH ROW
  EXECUTE FUNCTION contact_preference_event_append_only_trg();
