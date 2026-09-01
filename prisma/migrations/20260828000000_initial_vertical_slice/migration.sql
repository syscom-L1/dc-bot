CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "ReminderType" AS ENUM ('DUE_SOON_INACTIVE', 'OVERDUE', 'REVIEW_WAITING', 'MISSING_PROGRESS');
CREATE TYPE "ReminderResponseStatus" AS ENUM ('PENDING', 'STILL_WORKING', 'BLOCKED', 'COMPLETED', 'SNOOZED', 'NOT_ASSIGNEE');
CREATE TYPE "ProposalType" AS ENUM ('PROGRESS_UPDATE', 'STATUS_UPDATE', 'ISSUE_DRAFT', 'ISSUE_CREATION', 'PR_ISSUE_LINK', 'TARGET_DATE_CHANGE', 'DOCUMENT_UPDATE');
CREATE TYPE "ProposalStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED');
CREATE TYPE "LeaveNoticeStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'CANCELLED');

CREATE TABLE "people" (
  "id" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "discord_user_id" TEXT NOT NULL,
  "github_login" TEXT NOT NULL,
  "github_user_id" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Taipei',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_bindings" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "discord_guild_id" TEXT NOT NULL,
  "discord_channel_id" TEXT NOT NULL,
  "github_organization" TEXT NOT NULL,
  "github_project_id" TEXT,
  "github_installation_id" TEXT NOT NULL,
  "summary_channel_id" TEXT,
  "leave_channel_id" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repository_bindings" (
  "id" UUID NOT NULL,
  "project_binding_id" UUID NOT NULL,
  "github_repository_id" TEXT,
  "owner" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "repository_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
  "payload_hash" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "error_message" TEXT,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reminder_states" (
  "id" UUID NOT NULL,
  "person_id" UUID NOT NULL,
  "provider_item_id" TEXT NOT NULL,
  "reminder_type" "ReminderType" NOT NULL,
  "last_sent_at" TIMESTAMP(3),
  "snoozed_until" TIMESTAMP(3),
  "response_status" "ReminderResponseStatus" NOT NULL DEFAULT 'PENDING',
  "metadata_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reminder_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leave_notices" (
  "id" UUID NOT NULL,
  "person_id" UUID NOT NULL,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "source_message_id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "status" "LeaveNoticeStatus" NOT NULL DEFAULT 'PROPOSED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leave_notices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_issue_links" (
  "id" UUID NOT NULL,
  "project_binding_id" UUID,
  "discord_guild_id" TEXT NOT NULL,
  "discord_channel_id" TEXT NOT NULL,
  "discord_message_id" TEXT NOT NULL,
  "discord_thread_id" TEXT,
  "github_repository" TEXT NOT NULL,
  "github_issue_number" INTEGER NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_issue_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_proposals" (
  "id" UUID NOT NULL,
  "proposal_type" "ProposalType" NOT NULL,
  "status" "ProposalStatus" NOT NULL DEFAULT 'PROPOSED',
  "requested_by" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_reference" JSONB NOT NULL,
  "input_json" JSONB NOT NULL,
  "proposed_action_json" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "executed_at" TIMESTAMP(3),
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "before_json" JSONB,
  "after_json" JSONB,
  "request_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "people_discord_user_id_key" ON "people"("discord_user_id");
CREATE UNIQUE INDEX "people_github_login_key" ON "people"("github_login");
CREATE UNIQUE INDEX "project_bindings_discord_guild_id_discord_channel_id_key" ON "project_bindings"("discord_guild_id", "discord_channel_id");
CREATE INDEX "project_bindings_github_organization_github_project_id_idx" ON "project_bindings"("github_organization", "github_project_id");
CREATE UNIQUE INDEX "repository_bindings_owner_name_key" ON "repository_bindings"("owner", "name");
CREATE INDEX "repository_bindings_project_binding_id_idx" ON "repository_bindings"("project_binding_id");
CREATE UNIQUE INDEX "webhook_deliveries_provider_delivery_id_key" ON "webhook_deliveries"("provider", "delivery_id");
CREATE INDEX "webhook_deliveries_status_received_at_idx" ON "webhook_deliveries"("status", "received_at");
CREATE UNIQUE INDEX "reminder_states_person_id_provider_item_id_reminder_type_key" ON "reminder_states"("person_id", "provider_item_id", "reminder_type");
CREATE INDEX "reminder_states_snoozed_until_idx" ON "reminder_states"("snoozed_until");
CREATE INDEX "leave_notices_person_id_start_at_end_at_idx" ON "leave_notices"("person_id", "start_at", "end_at");
CREATE UNIQUE INDEX "message_issue_links_discord_message_id_key" ON "message_issue_links"("discord_message_id");
CREATE INDEX "message_issue_links_github_repository_github_issue_number_idx" ON "message_issue_links"("github_repository", "github_issue_number");
CREATE INDEX "ai_proposals_status_created_at_idx" ON "ai_proposals"("status", "created_at");
CREATE INDEX "ai_proposals_requested_by_idx" ON "ai_proposals"("requested_by");
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");
CREATE INDEX "audit_logs_request_id_idx" ON "audit_logs"("request_id");

ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_project_binding_id_fkey" FOREIGN KEY ("project_binding_id") REFERENCES "project_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_states" ADD CONSTRAINT "reminder_states_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_notices" ADD CONSTRAINT "leave_notices_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_issue_links" ADD CONSTRAINT "message_issue_links_project_binding_id_fkey" FOREIGN KEY ("project_binding_id") REFERENCES "project_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
