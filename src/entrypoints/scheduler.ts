import 'dotenv/config';
import { createInfrastructure } from '../bootstrap.js';
import { createLogger } from '../common/logger.js';
import { installGracefulShutdown } from '../common/shutdown.js';
import { loadConfig } from '../config/config.js';
import { loadGoogleConfig } from '../config/google-config.js';
import { JobScheduler } from '../queues/scheduler.js';

const config = loadConfig();
const googleConfig = loadGoogleConfig();
const logger = createLogger(config.logLevel);
const infrastructure = createInfrastructure(config);
await infrastructure.queues.checkConnection();
await new JobScheduler(infrastructure.queues, config, googleConfig.enabled && Boolean(googleConfig.calendarId)).register();
installGracefulShutdown(logger, [infrastructure.queues, infrastructure.database]);
logger.info('recurring job schedules registered');
