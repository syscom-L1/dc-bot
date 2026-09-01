-- CreateEnum
CREATE TYPE "AiNewsDigestStatus" AS ENUM ('PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiNewsLinkSummaryStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ai_news_settings" (
	"id" UUID NOT NULL,
	"discord_guild_id" TEXT NOT NULL,
	"discord_channel_id" TEXT NOT NULL,
	"enabled" BOOLEAN NOT NULL DEFAULT true,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "ai_news_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_news_digests" (
	"id" UUID NOT NULL,
	"setting_id" UUID NOT NULL,
	"digest_date" TEXT NOT NULL,
	"window_start" TIMESTAMP(3) NOT NULL,
	"window_end" TIMESTAMP(3) NOT NULL,
	"status" "AiNewsDigestStatus" NOT NULL DEFAULT 'PROCESSING',
	"discord_message_id" TEXT,
	"trace_id" TEXT NOT NULL,
	"error_message" TEXT,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "ai_news_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_news_digest_items" (
	"id" UUID NOT NULL,
	"digest_id" UUID NOT NULL,
	"rank" INTEGER NOT NULL,
	"category" TEXT NOT NULL,
	"brand" TEXT,
	"title" TEXT NOT NULL,
	"canonical_url" TEXT NOT NULL,
	"url_hash" TEXT NOT NULL,
	"provider" TEXT NOT NULL,
	"evidence_json" JSONB NOT NULL,
	"summary_json" JSONB NOT NULL,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT "ai_news_digest_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_news_link_summaries" (
	"id" UUID NOT NULL,
	"discord_guild_id" TEXT NOT NULL,
	"discord_channel_id" TEXT NOT NULL,
	"discord_message_id" TEXT NOT NULL,
	"discord_user_id" TEXT NOT NULL,
	"canonical_url" TEXT NOT NULL,
	"url_hash" TEXT NOT NULL,
	"status" "AiNewsLinkSummaryStatus" NOT NULL DEFAULT 'PROCESSING',
	"summary_json" JSONB,
	"reply_message_id" TEXT,
	"error_message" TEXT,
	"completed_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "ai_news_link_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_news_settings_discord_guild_id_key" ON "ai_news_settings"("discord_guild_id");
CREATE INDEX "ai_news_settings_enabled_idx" ON "ai_news_settings"("enabled");
CREATE UNIQUE INDEX "ai_news_digests_setting_id_digest_date_key" ON "ai_news_digests"("setting_id", "digest_date");
CREATE INDEX "ai_news_digests_status_created_at_idx" ON "ai_news_digests"("status", "created_at");
CREATE INDEX "ai_news_digests_setting_id_published_at_idx" ON "ai_news_digests"("setting_id", "published_at");
CREATE UNIQUE INDEX "ai_news_digest_items_digest_id_rank_key" ON "ai_news_digest_items"("digest_id", "rank");
CREATE INDEX "ai_news_digest_items_url_hash_created_at_idx" ON "ai_news_digest_items"("url_hash", "created_at");
CREATE UNIQUE INDEX "ai_news_link_summaries_discord_message_id_url_hash_key" ON "ai_news_link_summaries"("discord_message_id", "url_hash");
CREATE INDEX "ai_news_link_summaries_url_hash_status_completed_at_idx" ON "ai_news_link_summaries"("url_hash", "status", "completed_at");
CREATE INDEX "ai_news_link_summaries_discord_guild_id_discord_channel_id_created_at_idx" ON "ai_news_link_summaries"("discord_guild_id", "discord_channel_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_news_digests" ADD CONSTRAINT "ai_news_digests_setting_id_fkey" FOREIGN KEY ("setting_id") REFERENCES "ai_news_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_news_digest_items" ADD CONSTRAINT "ai_news_digest_items_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "ai_news_digests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
