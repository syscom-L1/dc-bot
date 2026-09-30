import 'dotenv/config';
import { createInfrastructure, createVerticalSlice } from '../bootstrap.js';
import { OpenAiCompatibleLlmAdapter } from '../ai/openai-compatible-adapter.js';
import { AiDiscussionService } from '../ai/discussion-service.js';
import { createLogger } from '../common/logger.js';
import { installGracefulShutdown } from '../common/shutdown.js';
import { loadConfig } from '../config/config.js';
import { loadLlmConfig } from '../config/llm-config.js';
import { loadGoogleConfig } from '../config/google-config.js';
import { loadMonitoringConfig } from '../config/monitoring-config.js';
import { DiscordAccessPolicy } from '../discord/access-policy.js';
import { DiscordGateway } from '../discord/gateway.js';
import { DiscordInteractionHandler } from '../discord/interaction-handler.js';
import { DiscordMessageIssueHandler } from '../discord/message-issue-handler.js';
import { DiscordAiDiscussionHandler } from '../discord/ai-discussion-handler.js';
import { DiscordLeaveHandler } from '../discord/leave-handler.js';
import { DiscordGoogleDocumentHandler } from '../discord/google-document-handler.js';
import { DiscordMonitoringHandler } from '../discord/monitoring-handler.js';
import { IssueDraftService } from '../issues/issue-draft.js';
import { IssueCreationService, OctokitIssueWriter, PrismaIssueProposalStore } from '../issues/issue-creation.js';
import { GoogleWorkspaceAdapter } from '../google/adapters.js';
import { GoogleDocumentProposalService, PrismaDocumentBindingStore, PrismaDocumentProposalStore } from '../google/document-service.js';
import { MonitoringAlertService, PrismaAlertStore } from '../monitoring/alert-service.js';
import { DiscordMonitoringAdapter } from '../monitoring/discord-adapter.js';
import { DiscordAiNewsHandler } from '../discord/ai-news-handler.js';

const config = loadConfig();
const llmConfig = loadLlmConfig();
const googleConfig = loadGoogleConfig();
const monitoringConfig = loadMonitoringConfig();
if (!config.discord.enabled || !config.github.enabled) {
  throw new Error('Bot process requires DISCORD_ENABLED=true and GITHUB_ENABLED=true');
}
if (!llmConfig.enabled) throw new Error('Bot process requires the CUBI LLM configuration');
const logger = createLogger(config.logLevel);
const infrastructure = createInfrastructure(config);
const services = createVerticalSlice(config, logger, infrastructure);
if (!services.proposals || !services.leaves || !infrastructure.github || !infrastructure.discord) {
  throw new Error('Bot integration services are unavailable');
}
const policy = new DiscordAccessPolicy(
  new Set(config.discord.guildIds),
  new Set(config.discord.channelIds),
  config.discord.adminRoleId,
  config.discord.adminChannelId,
);
const documentBindings = new PrismaDocumentBindingStore(infrastructure.database.client);
const google = googleConfig.enabled ? new GoogleWorkspaceAdapter(googleConfig) : undefined;
const handler = new DiscordInteractionHandler(
  policy,
  infrastructure.database,
  infrastructure.database,
  documentBindings,
  infrastructure.database,
  services.proposals,
  infrastructure.github,
  infrastructure.queues,
  logger,
  config.timezone,
	config.github.commitHistoryEnabled,
  { store: infrastructure.database, enabled: config.aiNews.enabled },
);
const llm = new OpenAiCompatibleLlmAdapter(llmConfig, logger);
const issueProposals = new PrismaIssueProposalStore(infrastructure.database.client);
const issueCreation = new IssueCreationService(
  issueProposals,
  new OctokitIssueWriter({ appId: config.github.appId, privateKey: config.github.privateKey }),
);
const messageIssueHandler = new DiscordMessageIssueHandler(
  policy,
  infrastructure.database,
  new IssueDraftService(llm),
  issueCreation,
  issueProposals,
  logger,
);
const aiDiscussionHandler = new DiscordAiDiscussionHandler(
  policy,
  infrastructure.database,
  infrastructure.github,
  infrastructure.discord,
  new AiDiscussionService(llm),
  Boolean(google),
  logger,
);
const leaveHandler = new DiscordLeaveHandler(
  policy,
  config.discord.leaveChannelId,
  infrastructure.database,
  services.leaves,
  logger,
);
const documentHandler = google
  ? new DiscordGoogleDocumentHandler(
      policy,
      infrastructure.database,
      documentBindings,
      new GoogleDocumentProposalService(
        llm,
        google,
        new PrismaDocumentProposalStore(infrastructure.database.client),
      ),
      logger,
    )
  : undefined;
const monitoringHandler = monitoringConfig.enabled
  ? new DiscordMonitoringHandler(
      policy,
      new MonitoringAlertService(
        new PrismaAlertStore(infrastructure.database.client),
        new DiscordMonitoringAdapter(config.discord.token, config.discord.alertChannelId),
        infrastructure.database,
      ),
      logger,
    )
  : undefined;
const aiNewsHandler = config.aiNews.enabled
	? new DiscordAiNewsHandler(
		policy,
		infrastructure.database,
		infrastructure.queues,
		config.aiNews.memberMaxLinks,
		logger,
	)
	: undefined;
if (monitoringConfig.enabled && !config.discord.alertChannelId) {
  throw new Error('DISCORD_ALERT_CHANNEL_ID is required when monitoring is enabled');
}
const gateway = new DiscordGateway(config.discord.token, handler, logger);
messageIssueHandler.register(gateway.client);
aiDiscussionHandler.register(gateway.client);
leaveHandler.register(gateway.client);
documentHandler?.register(gateway.client);
monitoringHandler?.register(gateway.client);
aiNewsHandler?.register(gateway.client);
installGracefulShutdown(logger, [gateway, infrastructure.queues, infrastructure.database]);
await gateway.start();
