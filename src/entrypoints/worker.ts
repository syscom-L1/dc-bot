import 'dotenv/config';
import { OpenAiCompatibleLlmAdapter } from '../ai/openai-compatible-adapter.js';
import { createInfrastructure, createVerticalSlice } from '../bootstrap.js';
import { createLogger } from '../common/logger.js';
import { installGracefulShutdown } from '../common/shutdown.js';
import { loadConfig } from '../config/config.js';
import { loadLlmConfig } from '../config/llm-config.js';
import { DailyReportReminderService, DailyReportSummaryService } from '../daily-reports/daily-report-service.js';
import { loadGoogleConfig } from '../config/google-config.js';
import { GoogleWorkspaceAdapter } from '../google/adapters.js';
import { CalendarNotificationService, PrismaCalendarNotificationStore } from '../google/calendar-service.js';
import { loadMonitoringConfig } from '../config/monitoring-config.js';
import { MonitoringAlertService, PrismaAlertStore } from '../monitoring/alert-service.js';
import { DiscordMonitoringAdapter } from '../monitoring/discord-adapter.js';
import { MonitoringAlertProcessor } from '../monitoring/webhook-service.js';
import { WorkerSystem } from '../queues/workers.js';
import { CommitHistorySummaryService } from '../summaries/commit-history-summary.js';

const config = loadConfig();
const llmConfig = loadLlmConfig();
const googleConfig = loadGoogleConfig();
const monitoringConfig = loadMonitoringConfig();
const logger = createLogger(config.logLevel);
const infrastructure = createInfrastructure(config);
if (!infrastructure.github || !infrastructure.discord) {
  throw new Error('Worker requires both GITHUB_ENABLED=true and DISCORD_ENABLED=true');
}
if (!llmConfig.enabled) throw new Error('Worker requires the CUBI LLM configuration');
const llm = new OpenAiCompatibleLlmAdapter(llmConfig, logger);
const commitHistory = config.github.commitHistoryEnabled
	? new CommitHistorySummaryService(infrastructure.github, llm, logger)
	: undefined;
const services = createVerticalSlice(config, logger, infrastructure, commitHistory);
if (!services.reminders || !services.weeklySummary || !services.reconciliation || !services.leaves) {
	throw new Error('Worker GitHub and Discord services are unavailable');
}
const riskRules = {
  dueSoonDays: config.rules.dueSoonDays,
  inactivityHours: config.rules.inactivityHours,
  reviewWaitHours: config.rules.reviewWaitHours,
};
const dailyReportReminder = new DailyReportReminderService(
  infrastructure.database, infrastructure.database, infrastructure.database,
  infrastructure.github, infrastructure.discord, config.timezone, riskRules, logger, commitHistory,
);
const dailyReportSummary = new DailyReportSummaryService(
  infrastructure.database, infrastructure.database, infrastructure.github,
  infrastructure.discord, llm, config.timezone, riskRules, commitHistory,
);
await infrastructure.queues.checkConnection();
const calendar = googleConfig.enabled && googleConfig.calendarId && infrastructure.discord
  ? new CalendarNotificationService(
      new GoogleWorkspaceAdapter(googleConfig),
      new PrismaCalendarNotificationStore(infrastructure.database.client),
      infrastructure.discord,
      googleConfig.calendarId,
      config.discord.summaryChannelId,
      googleConfig.reminderMinutes,
    )
  : undefined;
const monitoring = monitoringConfig.enabled
  ? new MonitoringAlertProcessor(
      infrastructure.database,
      new MonitoringAlertService(
        new PrismaAlertStore(infrastructure.database.client),
        new DiscordMonitoringAdapter(config.discord.token, config.discord.alertChannelId),
        infrastructure.database,
      ),
    )
  : undefined;
if (monitoringConfig.enabled && !config.discord.alertChannelId) {
  throw new Error('DISCORD_ALERT_CHANNEL_ID is required when monitoring is enabled');
}
const workers = new WorkerSystem(
  infrastructure.queues,
  services.webhookProcessor,
  dailyReportReminder,
  dailyReportSummary,
  services.weeklySummary,
  services.reminders,
  services.reconciliation,
  services.leaves,
  calendar,
  monitoring,
  logger,
);
workers.start();
installGracefulShutdown(logger, [workers, infrastructure.queues, infrastructure.database]);
logger.info('worker process started');
