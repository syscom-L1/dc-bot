import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const commaSeparated = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TIMEZONE: z.string().default('Asia/Taipei'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),

  DISCORD_ENABLED: booleanFromString,
  DISCORD_TOKEN: z.string().default(''),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_GUILD_IDS: commaSeparated,
  DISCORD_CHANNEL_IDS: commaSeparated,
  DISCORD_ADMIN_ROLE_ID: z.string().default(''),
  DISCORD_ADMIN_CHANNEL_ID: z.string().default(''),
  DISCORD_SUMMARY_CHANNEL_ID: z.string().default(''),
  DISCORD_LEAVE_CHANNEL_ID: z.string().default(''),
  DISCORD_ALERT_CHANNEL_ID: z.string().default(''),

  GITHUB_ENABLED: booleanFromString,
  GITHUB_APP_ID: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_PRIVATE_KEY: z.string().default(''),
  GITHUB_PRIVATE_KEY_BASE64: z.string().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  GITHUB_ORGANIZATION: z.string().default(''),
  GITHUB_PROJECT_ID: z.string().default(''),
  GITHUB_INSTALLATION_ID: z.string().default(''),
	GITHUB_COMMIT_HISTORY_ENABLED: booleanFromString,

  DAILY_REPORT_REMINDER_CRON: z.string().default('30 16 * * 1-5'),
  DAILY_SUMMARY_CRON: z.string().default('0 17 * * 1-5'),
  MORNING_NOTIFICATION_CRON: z.string().default('0 8 * * 1-5'),
  WEEKLY_SUMMARY_CRON: z.string().default('0 16 * * 5'),
  REMINDER_CRON: z.string().default('0 10 * * 1-5'),
  GITHUB_RECONCILIATION_CRON: z.string().default('15 */6 * * *'),
  DUE_SOON_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  INACTIVITY_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  REVIEW_WAIT_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  AUTO_UPDATE_GITHUB_STATUS: booleanFromString,
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  timezone: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  http: { host: string; port: number };
  databaseUrl: string;
  redisUrl: string;
  discord: {
    enabled: boolean;
    token: string;
    clientId: string;
    guildIds: string[];
    channelIds: string[];
    adminRoleId: string;
    adminChannelId: string;
    summaryChannelId: string;
    leaveChannelId: string;
    alertChannelId: string;
  };
  github: {
    enabled: boolean;
    appId: string;
    clientId: string;
    privateKey: string;
    webhookSecret: string;
    organization: string;
    projectId: string;
    installationId: string;
		commitHistoryEnabled: boolean;
  };
  schedules: {
    dailyReportReminder: string;
    dailySummary: string;
    morningNotification: string;
    weeklySummary: string;
    reminder: string;
    githubReconciliation: string;
  };
  rules: {
    dueSoonDays: number;
    inactivityHours: number;
    reviewWaitHours: number;
    autoUpdateGithubStatus: boolean;
  };
}

function decodePrivateKey(env: z.infer<typeof envSchema>): string {
  if (env.GITHUB_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  }
  return env.GITHUB_PRIVATE_KEY.replaceAll('\\n', '\n');
}

function requireWhenEnabled(enabled: boolean, values: Record<string, string>): void {
  if (!enabled) return;
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing required integration configuration: ${missing.join(', ')}`);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(source);
  const privateKey = decodePrivateKey(env);

  requireWhenEnabled(env.DISCORD_ENABLED, {
    DISCORD_TOKEN: env.DISCORD_TOKEN,
    DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID,
  });
  requireWhenEnabled(env.GITHUB_ENABLED, {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: privateKey,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
  });

  return {
    env: env.NODE_ENV,
    timezone: env.TIMEZONE,
    logLevel: env.LOG_LEVEL,
    http: { host: env.HTTP_HOST, port: env.HTTP_PORT },
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    discord: {
      enabled: env.DISCORD_ENABLED,
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      guildIds: env.DISCORD_GUILD_IDS,
      channelIds: env.DISCORD_CHANNEL_IDS,
      adminRoleId: env.DISCORD_ADMIN_ROLE_ID,
      adminChannelId: env.DISCORD_ADMIN_CHANNEL_ID,
      summaryChannelId: env.DISCORD_SUMMARY_CHANNEL_ID,
      leaveChannelId: env.DISCORD_LEAVE_CHANNEL_ID,
      alertChannelId: env.DISCORD_ALERT_CHANNEL_ID,
    },
    github: {
      enabled: env.GITHUB_ENABLED,
      appId: env.GITHUB_APP_ID,
      clientId: env.GITHUB_CLIENT_ID,
      privateKey,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      organization: env.GITHUB_ORGANIZATION,
      projectId: env.GITHUB_PROJECT_ID,
      installationId: env.GITHUB_INSTALLATION_ID,
			commitHistoryEnabled: env.GITHUB_COMMIT_HISTORY_ENABLED,
    },
    schedules: {
      dailyReportReminder: env.DAILY_REPORT_REMINDER_CRON,
      dailySummary: env.DAILY_SUMMARY_CRON,
      morningNotification: env.MORNING_NOTIFICATION_CRON,
      weeklySummary: env.WEEKLY_SUMMARY_CRON,
      reminder: env.REMINDER_CRON,
      githubReconciliation: env.GITHUB_RECONCILIATION_CRON,
    },
    rules: {
      dueSoonDays: env.DUE_SOON_DAYS,
      inactivityHours: env.INACTIVITY_HOURS,
      reviewWaitHours: env.REVIEW_WAIT_HOURS,
      autoUpdateGithubStatus: env.AUTO_UPDATE_GITHUB_STATUS,
    },
  };
}
