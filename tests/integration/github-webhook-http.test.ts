import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../../src/common/logger.js';
import { GitHubWebhookService } from '../../src/github/webhook-service.js';
import { buildHttpApp } from '../../src/http/app.js';
import { InMemoryDeliveries, InMemoryQueue, testConfig } from '../helpers.js';

describe('POST /webhooks/github', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  async function setup() {
    const deliveries = new InMemoryDeliveries();
    const queue = new InMemoryQueue();
    const config = testConfig();
    app = await buildHttpApp({
      config,
      logger: createLogger('error'),
      database: { checkConnection: async () => {}, close: async () => {} },
      queues: queue,
      webhooks: new GitHubWebhookService(deliveries, queue),
    });
    return { deliveries, queue, config };
  }

  it('accepts a valid signature and enqueues each delivery once', async () => {
    const { queue, config } = await setup();
    const body = JSON.stringify({ action: 'opened', issue: { number: 42 } });
    const signature = `sha256=${createHmac('sha256', config.github.webhookSecret).update(body).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issues',
      'x-hub-signature-256': signature,
    };
    const first = await app?.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
    const duplicate = await app?.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
    expect(first?.statusCode).toBe(202);
    expect(first?.json()).toEqual({ accepted: true, duplicate: false });
    expect(duplicate?.json()).toEqual({ accepted: true, duplicate: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.jobId).toBe('github-delivery-1');
  });

  it('rejects an invalid signature before persistence or queueing', async () => {
    const { queue, deliveries } = await setup();
    const response = await app?.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-2',
        'x-github-event': 'issues',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      payload: '{}',
    });
    expect(response?.statusCode).toBe(401);
    expect(queue.jobs).toHaveLength(0);
    expect(deliveries.records.size).toBe(0);
  });
});
