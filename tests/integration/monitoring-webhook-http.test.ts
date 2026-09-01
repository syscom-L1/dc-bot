import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/common/logger.js';
import { GitHubWebhookService } from '../../src/github/webhook-service.js';
import { buildHttpApp } from '../../src/http/app.js';
import { MonitoringWebhookService } from '../../src/monitoring/webhook-service.js';
import { InMemoryDeliveries, InMemoryQueue, testConfig } from '../helpers.js';

const alert = {
  source: 'grafana',
  fingerprint: 'api-5xx',
  service: 'cubi-api',
  environment: 'production',
  severity: 'critical',
  status: 'firing',
  title: 'API 5xx rate too high',
  description: '5xx > 20% for five minutes',
  startedAt: '2026-08-28T07:31:00.000Z',
  dashboardUrl: 'https://grafana.example/d/api',
};

describe('POST /webhooks/monitoring', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  async function setup() {
    const deliveries = new InMemoryDeliveries();
    const queue = new InMemoryQueue();
    const secret = 'monitoring-secret';
    app = await buildHttpApp({
      config: testConfig(),
      logger: createLogger('error'),
      database: { checkConnection: async () => {}, close: async () => {} },
      queues: queue,
      webhooks: new GitHubWebhookService(deliveries, queue),
      monitoring: { webhookSecret: secret, webhooks: new MonitoringWebhookService(deliveries, queue) },
    });
    return { deliveries, queue, secret };
  }

  it('validates HMAC and enqueues a normalized alert once', async () => {
    const { queue, secret } = await setup();
    const body = JSON.stringify(alert);
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-monitoring-delivery': 'alert-delivery-1',
      'x-monitoring-signature': signature,
    };
    const first = await app?.inject({ method: 'POST', url: '/webhooks/monitoring', headers, payload: body });
    const duplicate = await app?.inject({ method: 'POST', url: '/webhooks/monitoring', headers, payload: body });
    expect(first?.statusCode).toBe(202);
    expect(first?.json()).toEqual({ accepted: true, duplicate: false, deliveryId: 'alert-delivery-1' });
    expect(duplicate?.json()).toEqual({ accepted: true, duplicate: true, deliveryId: 'alert-delivery-1' });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.queue).toBe('monitoring-alert');
  });

  it('rejects an invalid signature before queueing', async () => {
    const { queue } = await setup();
    const response = await app?.inject({
      method: 'POST', url: '/webhooks/monitoring',
      headers: { 'content-type': 'application/json', 'x-monitoring-signature': `sha256=${'0'.repeat(64)}` },
      payload: JSON.stringify(alert),
    });
    expect(response?.statusCode).toBe(401);
    expect(queue.jobs).toHaveLength(0);
  });
});
