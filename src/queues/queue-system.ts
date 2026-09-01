import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { QueueAdapter } from '../domain/adapters.js';

export const queueNames = [
  'github-webhook',
  'github-reconciliation',
  'daily-report-reminder',
  'daily-summary',
  'morning-notification',
  'weekly-summary',
  'progress-reminder',
  'discord-notification',
  'llm-analysis',
  'google-document-update',
  'monitoring-alert',
  'calendar-notification',
  'dead-letter',
] as const;

export type QueueName = typeof queueNames[number];

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
};

export class BullQueueSystem implements QueueAdapter {
  public readonly connection: Redis;
  private readonly queues: Map<string, Queue>;

  public constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    this.queues = new Map(queueNames.map((name) => [
      name,
      new Queue(name, { connection: this.connection, defaultJobOptions }),
    ]));
  }

  public queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue: ${name}`);
    return queue;
  }

  public async enqueue(
    queueName: string,
    jobName: string,
    payload: object,
    options: { jobId: string; attempts?: number },
  ): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) throw new Error(`Unknown queue: ${queueName}`);
    await queue.add(jobName, payload, {
      jobId: options.jobId,
      attempts: options.attempts ?? 5,
    });
  }

  public async checkConnection(): Promise<void> {
    if (this.connection.status === 'wait') await this.connection.connect();
    await this.connection.ping();
  }

  public async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map(async (queue) => queue.close()));
    if (this.connection.status !== 'end') await this.connection.quit();
  }
}
