CREATE TABLE "alert_events" (
  "id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "dashboard_url" TEXT,
  "runbook_url" TEXT,
  "discord_message_id" TEXT,
  "discord_thread_id" TEXT,
  "assigned_to" TEXT,
  "muted_until" TIMESTAMP(3),
  "started_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "payload_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alert_events_source_fingerprint_environment_key"
  ON "alert_events"("source", "fingerprint", "environment");
CREATE INDEX "alert_events_status_severity_started_at_idx"
  ON "alert_events"("status", "severity", "started_at");
