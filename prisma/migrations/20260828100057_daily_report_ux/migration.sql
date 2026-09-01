-- CreateEnum
CREATE TYPE "DailyReportStatus" AS ENUM ('OPENING', 'OPEN', 'SUMMARIZED');

-- AlterTable
ALTER TABLE "repository_bindings" ADD COLUMN     "github_installation_id" TEXT;

-- CreateTable
CREATE TABLE "daily_report_sessions" (
    "id" UUID NOT NULL,
    "project_binding_id" UUID NOT NULL,
    "report_date" TEXT NOT NULL,
    "status" "DailyReportStatus" NOT NULL DEFAULT 'OPENING',
    "discord_channel_id" TEXT NOT NULL,
    "reminder_message_id" TEXT,
    "discord_thread_id" TEXT,
    "expected_discord_user_ids" TEXT[],
    "response_snapshot" JSONB,
    "summary_snapshot" JSONB,
    "summary_message_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "opened_at" TIMESTAMP(3),
    "closes_at" TIMESTAMP(3) NOT NULL,
    "summarized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_report_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_report_sessions_reminder_message_id_key" ON "daily_report_sessions"("reminder_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_report_sessions_discord_thread_id_key" ON "daily_report_sessions"("discord_thread_id");

-- CreateIndex
CREATE INDEX "daily_report_sessions_status_closes_at_idx" ON "daily_report_sessions"("status", "closes_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_report_sessions_project_binding_id_report_date_key" ON "daily_report_sessions"("project_binding_id", "report_date");

-- AddForeignKey
ALTER TABLE "daily_report_sessions" ADD CONSTRAINT "daily_report_sessions_project_binding_id_fkey" FOREIGN KEY ("project_binding_id") REFERENCES "project_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "calendar_notifications_calendar_id_event_id_event_start_at_noti" RENAME TO "calendar_notifications_calendar_id_event_id_event_start_at__key";
