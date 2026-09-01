import { z } from 'zod';

const schema = z.object({
  MONITORING_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  MONITORING_WEBHOOK_SECRET: z.string().default(''),
});

export interface MonitoringConfig {
  enabled: boolean;
  webhookSecret: string;
}

export function loadMonitoringConfig(source: NodeJS.ProcessEnv = process.env): MonitoringConfig {
  const env = schema.parse(source);
  if (env.MONITORING_ENABLED && !env.MONITORING_WEBHOOK_SECRET) {
    throw new Error('MONITORING_WEBHOOK_SECRET is required when monitoring is enabled');
  }
  return { enabled: env.MONITORING_ENABLED, webhookSecret: env.MONITORING_WEBHOOK_SECRET };
}
