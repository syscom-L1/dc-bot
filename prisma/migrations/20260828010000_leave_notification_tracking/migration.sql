ALTER TABLE "leave_notices"
  ADD COLUMN "source_channel_id" TEXT,
  ADD COLUMN "morning_notified_at" TIMESTAMP(3);

UPDATE "leave_notices"
SET "source_channel_id" = ''
WHERE "source_channel_id" IS NULL;

ALTER TABLE "leave_notices"
  ALTER COLUMN "source_channel_id" SET NOT NULL;

CREATE INDEX "leave_notices_status_start_at_morning_notified_at_idx"
  ON "leave_notices"("status", "start_at", "morning_notified_at");
