import 'dotenv/config';
import { createInfrastructure, createVerticalSlice } from '../bootstrap.js';
import { createLogger } from '../common/logger.js';
import { installGracefulShutdown } from '../common/shutdown.js';
import { loadConfig } from '../config/config.js';
import { loadGoogleConfig } from '../config/google-config.js';
import { GoogleWorkspaceAdapter } from '../google/adapters.js';
import { loadMonitoringConfig } from '../config/monitoring-config.js';
import { MonitoringWebhookService } from '../monitoring/webhook-service.js';
import { buildHttpApp } from '../http/app.js';

const config = loadConfig();
const googleConfig = loadGoogleConfig();
const monitoringConfig = loadMonitoringConfig();
const logger = createLogger(config.logLevel);
const infrastructure = createInfrastructure(config);
const services = createVerticalSlice(config, logger, infrastructure);
const app = await buildHttpApp({
  config,
  logger,
  database: infrastructure.database,
  queues: infrastructure.queues,
  webhooks: services.webhooks,
  ...(infrastructure.github ? { github: infrastructure.github } : {}),
  ...(infrastructure.discord ? { discord: infrastructure.discord } : {}),
  ...(googleConfig.enabled ? { google: { adapter: new GoogleWorkspaceAdapter(googleConfig), calendarId: googleConfig.calendarId } } : {}),
  ...(monitoringConfig.enabled ? {
    monitoring: {
      webhookSecret: monitoringConfig.webhookSecret,
      webhooks: new MonitoringWebhookService(infrastructure.database, infrastructure.queues),
    },
  } : {}),
});

installGracefulShutdown(logger, [app, infrastructure.queues, infrastructure.database]);
await app.listen(config.http);
