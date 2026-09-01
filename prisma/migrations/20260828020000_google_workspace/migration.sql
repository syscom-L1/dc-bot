CREATE TABLE "document_bindings" (
  "id" UUID NOT NULL,
  "project_binding_id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'google_docs',
  "document_id" TEXT NOT NULL,
  "document_url" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "allowed_operations" TEXT[] NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "calendar_notifications" (
  "id" UUID NOT NULL,
  "calendar_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_start_at" TIMESTAMP(3) NOT NULL,
  "notification_type" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "calendar_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_bindings_project_binding_id_provider_document_id_key"
  ON "document_bindings"("project_binding_id", "provider", "document_id");
CREATE INDEX "document_bindings_document_id_idx" ON "document_bindings"("document_id");
CREATE UNIQUE INDEX "calendar_notifications_calendar_id_event_id_event_start_at_notification_type_key"
  ON "calendar_notifications"("calendar_id", "event_id", "event_start_at", "notification_type");

ALTER TABLE "document_bindings"
  ADD CONSTRAINT "document_bindings_project_binding_id_fkey"
  FOREIGN KEY ("project_binding_id") REFERENCES "project_bindings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
