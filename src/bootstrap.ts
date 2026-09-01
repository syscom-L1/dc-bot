import type { Logger } from 'pino';
import type { AppConfig } from './config/config.js';
import { DiscordRestAdapter } from './discord/rest-adapter.js';
import { OctokitGitHubAdapter } from './github/octokit-adapter.js';
import { GitHubWebhookProcessor } from './github/webhook-processor.js';
import { GitHubReconciliationService } from './github/reconciliation.js';
import { GitHubWebhookService } from './github/webhook-service.js';
import { PrismaStore } from './persistence/prisma.js';
import { BullQueueSystem } from './queues/queue-system.js';
import { ProgressProposalService, ProgressReminderService } from './reminders/reminder-service.js';
import { DailySummaryService } from './summaries/daily-summary.js';
import { WeeklySummaryService } from './summaries/weekly-summary.js';
import { LeaveService, PrismaLeaveStore } from './leave/leave-service.js';

export function createInfrastructure(config: AppConfig) {
  const database = new PrismaStore();
  const queues = new BullQueueSystem(config.redisUrl);
  const github = config.github.enabled
    ? new OctokitGitHubAdapter({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;
  const discord = config.discord.enabled ? new DiscordRestAdapter(config.discord.token) : undefined;
  return { database, queues, github, discord };
}

export function createVerticalSlice(
  config: AppConfig,
  logger: Logger,
  infrastructure: ReturnType<typeof createInfrastructure>,
) {
  const { database, queues, github, discord } = infrastructure;
  const webhooks = new GitHubWebhookService(database, queues);
  const webhookProcessor = new GitHubWebhookProcessor(database, database, logger);
  if (!github || !discord) {
    return { webhooks, webhookProcessor };
  }
  const riskRules = {
    dueSoonDays: config.rules.dueSoonDays,
    inactivityHours: config.rules.inactivityHours,
    reviewWaitHours: config.rules.reviewWaitHours,
  };
  const dailySummary = new DailySummaryService(
    database,
    github,
    discord,
    config.timezone,
    riskRules,
  );
  const weeklySummary = new WeeklySummaryService(database, github, discord, config.rules.inactivityHours);
  const reminders = new ProgressReminderService(
    database,
    database,
    database,
    github,
    discord,
    riskRules,
  );
  const proposals = new ProgressProposalService(database, database, database, github, database);
  const reconciliation = new GitHubReconciliationService(database, github);
  const leaves = new LeaveService(new PrismaLeaveStore(database.client), discord, database);
  return { webhooks, webhookProcessor, dailySummary, weeklySummary, reminders, proposals, reconciliation, leaves };
}
