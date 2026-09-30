import type { WebhookDeliveryStatus } from '@prisma/client';
import type { AppConfig } from '../src/config/config.js';
import type { QueueAdapter } from '../src/domain/adapters.js';
import type { WebhookDeliveryStore } from '../src/persistence/contracts.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    timezone: 'Asia/Taipei',
    logLevel: 'error',
    http: { host: '127.0.0.1', port: 3000 },
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    redisUrl: 'redis://localhost:6379',
    discord: {
      enabled: false,
      token: '',
      clientId: '',
      guildIds: [],
      channelIds: [],
      adminRoleId: '',
      adminChannelId: '',
      summaryChannelId: '',
      leaveChannelId: '',
      alertChannelId: '',
    },
    github: {
      enabled: true,
      appId: '1',
      clientId: '',
      privateKey: 'not-used-in-tests',
      webhookSecret: 'test-webhook-secret',
      organization: 'acme',
      projectId: '',
      installationId: '',
			commitHistoryEnabled: false,
    },
    aiNews: {
      enabled: false,
      primarySourceUrl: 'https://news.smol.ai/rss.xml',
      initialLookbackHours: 72,
      maxLookbackHours: 96,
      majorOutageMinutes: 60,
      memberMaxLinks: 3,
    },
    schedules: {
      dailyReportReminder: '30 16 * * 1-5',
      dailySummary: '0 17 * * 1-5',
      morningNotification: '0 8 * * 1-5',
      weeklySummary: '0 16 * * 5',
      reminder: '0 10 * * 1-5',
      githubReconciliation: '15 */6 * * *',
      aiNews: '0 9 * * 1-5',
    },
    rules: {
      dueSoonDays: 3,
      inactivityHours: 48,
      reviewWaitHours: 24,
      autoUpdateGithubStatus: false,
    },
    ...overrides,
  };
}

export class InMemoryDeliveries implements WebhookDeliveryStore {
  public readonly records = new Map<string, { eventType: string; status: WebhookDeliveryStatus; hash: string }>();

  public async tryCreate(input: {
    provider: string;
    deliveryId: string;
    eventType: string;
    payloadHash: string;
  }): Promise<boolean> {
    const key = `${input.provider}/${input.deliveryId}`;
    if (this.records.has(key)) return false;
    this.records.set(key, { eventType: input.eventType, status: 'RECEIVED', hash: input.payloadHash });
    return true;
  }

  public async updateStatus(
    provider: string,
    deliveryId: string,
    status: WebhookDeliveryStatus,
  ): Promise<void> {
    const key = `${provider}/${deliveryId}`;
    const existing = this.records.get(key);
    if (!existing) throw new Error('Delivery not found');
    existing.status = status;
  }
}

export class InMemoryQueue implements QueueAdapter {
  public readonly jobs: Array<{ queue: string; name: string; payload: object; jobId: string }> = [];

  public async enqueue(
    queueName: string,
    jobName: string,
    payload: object,
    options: { jobId: string },
  ): Promise<void> {
    this.jobs.push({ queue: queueName, name: jobName, payload, jobId: options.jobId });
  }

  public async checkConnection(): Promise<void> {}
}
