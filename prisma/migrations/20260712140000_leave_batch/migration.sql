-- Range bookings: rows created in one booking share a batch id (display/edit/delete as one
-- unit). NULL = legacy/single ad-hoc row. Storage stays PER-DAY. ADDITIVE.
ALTER TABLE "LeaveRecord" ADD COLUMN "leave_batch_id" TEXT;
CREATE INDEX "LeaveRecord_leave_batch_id_idx" ON "LeaveRecord"("leave_batch_id");
