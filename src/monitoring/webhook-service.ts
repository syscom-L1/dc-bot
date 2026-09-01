import { createHash } from 'node:crypto';
import { WebhookDeliveryStatus } from '@prisma/client';
import type { QueueAdapter } from '../domain/adapters.js';
import type { WebhookDeliveryStore } from '../persistence/contracts.js';
import type { MonitoringAlertService } from './alert-service.js';

export interface MonitoringAlertJob {
  deliveryId: string;
  payload: unknown;
}

export class MonitoringWebhookService {
  public constructor(
    private readonly deliveries: WebhookDeliveryStore,
    private readonly queue: QueueAdapter,
  ) {}

  public async ingest(input: { deliveryId?: string; payload: unknown; rawPayload: Buffer }): Promise<{ duplicate: boolean; deliveryId: string }> {
    const payloadHash = createHash('sha256').update(input.rawPayload).digest('hex');
    const deliveryId = input.deliveryId ?? payloadHash;
    const created = await this.deliveries.tryCreate({
      provider: 'monitoring', deliveryId, eventType: 'alert', payloadHash,
    });
    if (!created) return { duplicate: true, deliveryId };
    try {
      await this.queue.enqueue('monitoring-alert', 'process', { deliveryId, payload: input.payload }, {
        jobId: `monitoring-${deliveryId}`,
        attempts: 5,
      });
      await this.deliveries.updateStatus('monitoring', deliveryId, WebhookDeliveryStatus.QUEUED);
      return { duplicate: false, deliveryId };
    } catch (error) {
      await this.deliveries.updateStatus(
        'monitoring', deliveryId, WebhookDeliveryStatus.FAILED,
        error instanceof Error ? error.message : 'Unknown monitoring queue error',
      );
      throw error;
    }
  }
}

export class MonitoringAlertProcessor {
  public constructor(
    private readonly deliveries: WebhookDeliveryStore,
    private readonly alerts: MonitoringAlertService,
  ) {}

  public async process(job: MonitoringAlertJob): Promise<void> {
    await this.deliveries.updateStatus('monitoring', job.deliveryId, WebhookDeliveryStatus.PROCESSING);
    try {
      await this.alerts.process(job.payload);
      await this.deliveries.updateStatus('monitoring', job.deliveryId, WebhookDeliveryStatus.PROCESSED);
    } catch (error) {
      await this.deliveries.updateStatus(
        'monitoring', job.deliveryId, WebhookDeliveryStatus.FAILED,
        error instanceof Error ? error.message : 'Unknown monitoring processing error',
      );
      throw error;
    }
  }
}
