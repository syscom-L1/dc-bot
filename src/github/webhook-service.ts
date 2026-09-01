import { createHash } from 'node:crypto';
import { WebhookDeliveryStatus } from '@prisma/client';
import type { QueueAdapter } from '../domain/adapters.js';
import type { WebhookDeliveryStore } from '../persistence/contracts.js';

export interface GitHubWebhookJob {
  deliveryId: string;
  eventType: string;
  payload: unknown;
}

export class GitHubWebhookService {
  public constructor(
    private readonly deliveries: WebhookDeliveryStore,
    private readonly queue: QueueAdapter,
  ) {}

  public async ingest(input: GitHubWebhookJob & { rawPayload: Buffer }): Promise<{ duplicate: boolean }> {
    const payloadHash = createHash('sha256').update(input.rawPayload).digest('hex');
    const created = await this.deliveries.tryCreate({
      provider: 'github',
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      payloadHash,
    });
    if (!created) return { duplicate: true };

    try {
      await this.queue.enqueue(
        'github-webhook',
        input.eventType,
        { deliveryId: input.deliveryId, eventType: input.eventType, payload: input.payload },
        { jobId: `github-${input.deliveryId}`, attempts: 5 },
      );
      await this.deliveries.updateStatus(
        'github',
        input.deliveryId,
        WebhookDeliveryStatus.QUEUED,
      );
      return { duplicate: false };
    } catch (error) {
      await this.deliveries.updateStatus(
        'github',
        input.deliveryId,
        WebhookDeliveryStatus.FAILED,
        error instanceof Error ? error.message : 'Unknown queue error',
      );
      throw error;
    }
  }
}
