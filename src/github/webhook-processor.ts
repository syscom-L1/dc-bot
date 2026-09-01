import { WebhookDeliveryStatus } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditStore, WebhookDeliveryStore } from '../persistence/contracts.js';
import type { GitHubWebhookJob } from './webhook-service.js';

const supportedEvents = new Set([
  'issues',
  'pull_request',
  'pull_request_review',
  'workflow_run',
  'push',
  'installation',
  'installation_repositories',
]);

const webhookEnvelopeSchema = z.object({
  action: z.string().optional(),
  sender: z.object({ login: z.string() }).optional(),
  repository: z.object({ full_name: z.string() }).optional(),
  issue: z.object({ number: z.number(), state: z.string() }).optional(),
  pull_request: z.object({ number: z.number(), state: z.string(), merged: z.boolean().optional() }).optional(),
  workflow_run: z.object({ id: z.number(), conclusion: z.string().nullable(), html_url: z.string() }).optional(),
}).passthrough();

export class GitHubWebhookProcessor {
  public constructor(
    private readonly deliveries: WebhookDeliveryStore,
    private readonly audit: AuditStore,
    private readonly logger: Logger,
  ) {}

  public async process(job: GitHubWebhookJob): Promise<void> {
    await this.deliveries.updateStatus(
      'github',
      job.deliveryId,
      WebhookDeliveryStatus.PROCESSING,
    );
    try {
      if (!supportedEvents.has(job.eventType)) {
        this.logger.info({ eventType: job.eventType }, 'ignored unsupported GitHub event');
      } else {
        const payload = webhookEnvelopeSchema.parse(job.payload);
        const resourceNumber = payload.issue?.number ?? payload.pull_request?.number;
        await this.audit.append({
          actorType: 'github',
          actorId: payload.sender?.login ?? 'github-app',
          action: `github.webhook.${job.eventType}.${payload.action ?? 'received'}`,
          resourceType: payload.repository ? 'github_repository' : 'github_app',
          resourceId: payload.repository?.full_name ?? 'installation',
          after: {
            deliveryId: job.deliveryId,
            eventType: job.eventType,
            action: payload.action ?? null,
            resourceNumber: resourceNumber ?? null,
            state: payload.issue?.state ?? payload.pull_request?.state ?? null,
            merged: payload.pull_request?.merged ?? null,
            workflowConclusion: payload.workflow_run?.conclusion ?? null,
          },
          requestId: job.deliveryId,
        });
      }
      await this.deliveries.updateStatus(
        'github',
        job.deliveryId,
        WebhookDeliveryStatus.PROCESSED,
      );
    } catch (error) {
      await this.deliveries.updateStatus(
        'github',
        job.deliveryId,
        WebhookDeliveryStatus.FAILED,
        error instanceof Error ? error.message : 'Unknown webhook processing error',
      );
      throw error;
    }
  }
}
