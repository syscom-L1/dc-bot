import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../common/errors.js';
import type { AuditStore } from '../persistence/contracts.js';

export const monitoringAlertSchema = z.object({
  source: z.string().min(1).max(100),
  fingerprint: z.string().min(1).max(500),
  service: z.string().min(1).max(200),
  environment: z.string().min(1).max(100),
  severity: z.enum(['info', 'warning', 'critical']),
  status: z.enum(['firing', 'resolved']),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(4_000),
  startedAt: z.string().datetime(),
  dashboardUrl: z.string().url().optional(),
  runbookUrl: z.string().url().optional(),
});

export type MonitoringAlert = z.infer<typeof monitoringAlertSchema>;

export interface AlertRecord extends MonitoringAlert {
  id: string;
  startedAt: string;
  resolvedAt: Date | null;
  discordMessageId: string | null;
  discordThreadId: string | null;
  assignedTo: string | null;
  mutedUntil: Date | null;
}

export interface AlertStore {
  upsert(alert: MonitoringAlert): Promise<AlertRecord>;
  find(id: string): Promise<AlertRecord | null>;
  setDiscordReferences(id: string, messageId: string, threadId?: string): Promise<void>;
  assign(id: string, discordUserId: string): Promise<AlertRecord>;
  mute(id: string, until: Date | null): Promise<AlertRecord>;
}

function record(value: {
  id: string; source: string; fingerprint: string; service: string; environment: string;
  severity: string; status: string; title: string; description: string; startedAt: Date;
  resolvedAt: Date | null; dashboardUrl: string | null; runbookUrl: string | null;
  discordMessageId: string | null; discordThreadId: string | null; assignedTo: string | null;
  mutedUntil: Date | null;
}): AlertRecord {
  return monitoringAlertSchema.extend({ id: z.string(), resolvedAt: z.date().nullable(), discordMessageId: z.string().nullable(), discordThreadId: z.string().nullable(), assignedTo: z.string().nullable(), mutedUntil: z.date().nullable() }).parse({
    ...value,
    severity: value.severity,
    status: value.status,
    startedAt: value.startedAt.toISOString(),
    dashboardUrl: value.dashboardUrl ?? undefined,
    runbookUrl: value.runbookUrl ?? undefined,
  });
}

export class PrismaAlertStore implements AlertStore {
  public constructor(private readonly client: PrismaClient) {}

  public async upsert(alert: MonitoringAlert): Promise<AlertRecord> {
    const startedAt = new Date(alert.startedAt);
    const value = await this.client.alertEvent.upsert({
      where: { source_fingerprint_environment: {
        source: alert.source, fingerprint: alert.fingerprint, environment: alert.environment,
      } },
      create: {
        source: alert.source,
        fingerprint: alert.fingerprint,
        service: alert.service,
        environment: alert.environment,
        severity: alert.severity,
        status: alert.status,
        title: alert.title,
        description: alert.description,
        dashboardUrl: alert.dashboardUrl ?? null,
        runbookUrl: alert.runbookUrl ?? null,
        startedAt,
        resolvedAt: alert.status === 'resolved' ? new Date() : null,
        payloadJson: alert,
      },
      update: {
        service: alert.service,
        severity: alert.severity,
        status: alert.status,
        title: alert.title,
        description: alert.description,
        startedAt,
        resolvedAt: alert.status === 'resolved' ? new Date() : null,
        dashboardUrl: alert.dashboardUrl ?? null,
        runbookUrl: alert.runbookUrl ?? null,
        payloadJson: alert,
      },
    });
    return record(value);
  }

  public async find(id: string): Promise<AlertRecord | null> {
    const value = await this.client.alertEvent.findUnique({ where: { id } });
    return value ? record(value) : null;
  }

  public async setDiscordReferences(id: string, messageId: string, threadId?: string): Promise<void> {
    await this.client.alertEvent.update({
      where: { id },
      data: { discordMessageId: messageId, ...(threadId ? { discordThreadId: threadId } : {}) },
    });
  }

  public async assign(id: string, discordUserId: string): Promise<AlertRecord> {
    return record(await this.client.alertEvent.update({
      where: { id }, data: { assignedTo: discordUserId },
    }));
  }

  public async mute(id: string, until: Date | null): Promise<AlertRecord> {
    return record(await this.client.alertEvent.update({ where: { id }, data: { mutedUntil: until } }));
  }
}

export interface MonitoringDiscordAdapter {
  createAlert(content: string, alert: AlertRecord): Promise<string>;
  updateAlert(messageId: string, content: string, alert: AlertRecord): Promise<void>;
  createCriticalThread(messageId: string, name: string): Promise<string>;
}

const severityIcon: Record<MonitoringAlert['severity'], string> = {
  info: '🔵', warning: '🟠', critical: '🔴',
};

export function renderAlert(alert: AlertRecord): string {
  const status = alert.status === 'resolved' ? '✅ 已恢復' : alert.assignedTo ? `處理中（<@${alert.assignedTo}>）` : '尚未處理';
  const muted = alert.mutedUntil && alert.mutedUntil > new Date() ? `\n靜音至：${alert.mutedUntil.toISOString()}` : '';
  const links = [
    alert.dashboardUrl ? `[查看監控](<${alert.dashboardUrl}>)` : null,
    alert.runbookUrl ? `[Runbook](<${alert.runbookUrl}>)` : null,
  ].filter(Boolean).join('｜');
  return `${severityIcon[alert.severity]} ${alert.severity.toUpperCase()}｜${alert.environment}｜${alert.service}

**${alert.title}**

${alert.description}

狀態：${status}
開始時間：${alert.startedAt}${alert.resolvedAt ? `\n恢復時間：${alert.resolvedAt.toISOString()}` : ''}${muted}
${links ? `\n${links}` : ''}`;
}

export class MonitoringAlertService {
  public constructor(
    private readonly alerts: AlertStore,
    private readonly discord: MonitoringDiscordAdapter,
    private readonly audit: AuditStore,
  ) {}

  public async process(input: unknown): Promise<AlertRecord> {
    const payload = monitoringAlertSchema.parse(input);
    let alert = await this.alerts.upsert(payload);
    const muted = alert.mutedUntil && alert.mutedUntil > new Date();
    if (muted && alert.status === 'firing') return alert;
    const content = renderAlert(alert);
    if (alert.discordMessageId) {
      await this.discord.updateAlert(alert.discordMessageId, content, alert);
      if (alert.severity === 'critical' && alert.status === 'firing' && !alert.discordThreadId) {
        const threadId = await this.discord.createCriticalThread(
          alert.discordMessageId,
          (alert.service + '｜' + alert.title).slice(0, 100),
        );
        await this.alerts.setDiscordReferences(alert.id, alert.discordMessageId, threadId);
        alert = { ...alert, discordThreadId: threadId };
      }
    } else {
      const messageId = await this.discord.createAlert(content, alert);
      let threadId: string | undefined;
      if (alert.severity === 'critical' && alert.status === 'firing') {
        threadId = await this.discord.createCriticalThread(messageId, (alert.service + '｜' + alert.title).slice(0, 100));
      }
      await this.alerts.setDiscordReferences(alert.id, messageId, threadId);
      alert = { ...alert, discordMessageId: messageId, discordThreadId: threadId ?? null };
    }
    return alert;
  }

  public async acknowledge(id: string, actorId: string, requestId: string): Promise<void> {
    const alert = await this.alerts.assign(id, actorId);
    if (!alert.discordMessageId) throw new NotFoundError('Discord alert message not found');
    await this.discord.updateAlert(alert.discordMessageId, renderAlert(alert), alert);
    await this.audit.append({ actorType: 'discord_user', actorId, action: 'monitoring.alert.ack', resourceType: 'alert', resourceId: id, after: { assignedTo: actorId }, requestId });
  }

  public async mute(id: string, actorId: string, minutes: number, requestId: string): Promise<void> {
    const existing = await this.alerts.find(id);
    if (!existing) throw new NotFoundError('Alert not found');
    if (existing.status === 'resolved') throw new ConflictError('Resolved alert cannot be muted');
    const alert = await this.alerts.mute(id, new Date(Date.now() + minutes * 60_000));
    if (alert.discordMessageId) await this.discord.updateAlert(alert.discordMessageId, renderAlert(alert), alert);
    await this.audit.append({ actorType: 'discord_user', actorId, action: 'monitoring.alert.mute', resourceType: 'alert', resourceId: id, after: { minutes }, requestId });
  }

  public async resume(id: string, actorId: string, requestId: string): Promise<void> {
    const alert = await this.alerts.mute(id, null);
    if (alert.discordMessageId) await this.discord.updateAlert(alert.discordMessageId, renderAlert(alert), alert);
    await this.audit.append({ actorType: 'discord_user', actorId, action: 'monitoring.alert.resume', resourceType: 'alert', resourceId: id, requestId });
  }
}
