import rawBody from 'fastify-raw-body';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig } from '../config/config.js';
import type { DiscordAdapter, GitHubAdapter, QueueAdapter } from '../domain/adapters.js';
import { AppError } from '../common/errors.js';
import { verifyGitHubSignature } from '../github/signature.js';
import type { GitHubWebhookService } from '../github/webhook-service.js';
import type { DatabaseHealth } from '../persistence/contracts.js';
import { monitoringAlertSchema } from '../monitoring/alert-service.js';
import type { MonitoringWebhookService } from '../monitoring/webhook-service.js';
import type { GoogleCalendarAdapter, GoogleDocsAdapter } from '../google/adapters.js';

export interface HttpAppDependencies {
  config: AppConfig;
  logger: Logger;
  database: DatabaseHealth;
  queues: QueueAdapter;
  github?: GitHubAdapter;
  discord?: DiscordAdapter;
  google?: { adapter: GoogleDocsAdapter & GoogleCalendarAdapter; calendarId: string };
  monitoring?: { webhookSecret: string; webhooks: MonitoringWebhookService };
  webhooks: GitHubWebhookService;
}

const githubHeadersSchema = z.object({
  'x-github-delivery': z.string().min(1),
  'x-github-event': z.string().min(1),
  'x-hub-signature-256': z.string().min(1),
});

async function withTimeout(name: string, operation: Promise<void>, milliseconds = 3_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} readiness check timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildHttpApp(dependencies: HttpAppDependencies) {
  const app = Fastify({
    loggerInstance: dependencies.logger,
    trustProxy: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 2 * 1_024 * 1_024,
  });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });

  app.get('/health', () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, Promise<void>> = {
      postgres: withTimeout('postgres', dependencies.database.checkConnection()),
      valkey: withTimeout('valkey', dependencies.queues.checkConnection()),
    };
    if (dependencies.config.github.enabled && dependencies.github) {
      checks.github = withTimeout(
        'github',
        dependencies.github.checkConnection(dependencies.config.github.installationId || undefined),
      );
    }
    if (dependencies.config.discord.enabled && dependencies.discord) {
      checks.discord = withTimeout('discord', dependencies.discord.checkConnection());
    }
    if (dependencies.google?.calendarId) {
      checks.google = withTimeout('google', dependencies.google.adapter.checkCalendar(dependencies.google.calendarId));
    }
    const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
      try {
        await check;
        return [name, 'ok'] as const;
      } catch (error) {
        return [name, error instanceof Error ? error.message : 'failed'] as const;
      }
    }));
    const status = Object.fromEntries(entries);
    const ready = Object.values(status).every((value) => value === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: status });
  });

  app.post('/webhooks/github', { config: { rawBody: true } }, async (request, reply) => {
    if (!dependencies.config.github.enabled) {
      return reply.status(503).send({ error: 'GitHub integration is disabled' });
    }
    const headers = githubHeadersSchema.safeParse(request.headers);
    if (!headers.success || !request.rawBody) {
      return reply.status(400).send({ error: 'Missing required GitHub webhook headers or body' });
    }
    const rawPayload = Buffer.isBuffer(request.rawBody)
      ? request.rawBody
      : Buffer.from(request.rawBody);
    if (!verifyGitHubSignature(
      rawPayload,
      headers.data['x-hub-signature-256'],
      dependencies.config.github.webhookSecret,
    )) {
      request.log.warn({ deliveryId: headers.data['x-github-delivery'] }, 'invalid GitHub webhook signature');
      return reply.status(401).send({ error: 'Invalid webhook signature' });
    }
    const result = await dependencies.webhooks.ingest({
      deliveryId: headers.data['x-github-delivery'],
      eventType: headers.data['x-github-event'],
      payload: request.body,
      rawPayload: rawPayload,
    });
    return reply.status(202).send({ accepted: true, duplicate: result.duplicate });
  });

  app.post('/webhooks/monitoring', { config: { rawBody: true } }, async (request, reply) => {
    if (!dependencies.monitoring) return reply.status(503).send({ error: 'Monitoring integration is disabled' });
    const signatureHeader = request.headers['x-monitoring-signature'];
    if (typeof signatureHeader !== 'string' || !request.rawBody) {
      return reply.status(400).send({ error: 'Missing monitoring signature or body' });
    }
    const rawPayload = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.from(request.rawBody);
    if (!verifyGitHubSignature(rawPayload, signatureHeader, dependencies.monitoring.webhookSecret)) {
      return reply.status(401).send({ error: 'Invalid monitoring webhook signature' });
    }
    const payload = monitoringAlertSchema.parse(request.body);
    const deliveryHeader = request.headers['x-monitoring-delivery'];
    const result = await dependencies.monitoring.webhooks.ingest({
      ...(typeof deliveryHeader === 'string' ? { deliveryId: deliveryHeader } : {}),
      payload,
      rawPayload,
    });
    return reply.status(202).send({ accepted: true, duplicate: result.duplicate, deliveryId: result.deliveryId });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'HTTP request failed');
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Request payload is invalid',
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
      return;
    }
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    void reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  return app;
}
