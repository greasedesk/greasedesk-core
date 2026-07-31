-- Staff-composed messages on a thread.
--
-- body: the words a person chose. NULL for templated sends, where the template key + data are the
-- record and the body is reproducible. Only the free_text template populates this.
ALTER TABLE "NotificationLog" ADD COLUMN "body" TEXT;

-- sent_by_user: who pressed send. NULL = the system emitted it (quote going out, receipt cron).
-- A person deciding to contact a customer is a different act, and the null is what distinguishes them.
ALTER TABLE "NotificationLog" ADD COLUMN "sent_by_user" TEXT;
