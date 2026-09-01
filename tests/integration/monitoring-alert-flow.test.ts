import { describe, expect, it } from 'vitest';
import type { AuditStore } from '../../src/persistence/contracts.js';
import {
  MonitoringAlertService,
  type AlertRecord,
  type AlertStore,
  type MonitoringAlert,
  type MonitoringDiscordAdapter,
} from '../../src/monitoring/alert-service.js';

class Alerts implements AlertStore {
  public record: AlertRecord | null = null;
  public async upsert(alert: MonitoringAlert): Promise<AlertRecord> {
    this.record = {
      ...alert,
      id: this.record?.id ?? 'alert-1',
      resolvedAt: alert.status === 'resolved' ? new Date('2026-08-28T08:00:00Z') : null,
      discordMessageId: this.record?.discordMessageId ?? null,
      discordThreadId: this.record?.discordThreadId ?? null,
      assignedTo: this.record?.assignedTo ?? null,
      mutedUntil: this.record?.mutedUntil ?? null,
    };
    return this.record;
  }
  public async find(): Promise<AlertRecord | null> { return this.record; }
  public async setDiscordReferences(_id: string, messageId: string, threadId?: string): Promise<void> {
    if (this.record) {
      this.record.discordMessageId = messageId;
      this.record.discordThreadId = threadId ?? null;
    }
  }
  public async assign(_id: string, user: string): Promise<AlertRecord> {
    if (!this.record) throw new Error('missing');
    this.record.assignedTo = user;
    return this.record;
  }
  public async mute(_id: string, until: Date | null): Promise<AlertRecord> {
    if (!this.record) throw new Error('missing');
    this.record.mutedUntil = until;
    return this.record;
  }
}

class Discord implements MonitoringDiscordAdapter {
  public creates = 0;
  public updates = 0;
  public threads = 0;
  public async createAlert(): Promise<string> { this.creates += 1; return 'message-1'; }
  public async updateAlert(): Promise<void> { this.updates += 1; }
  public async createCriticalThread(): Promise<string> { this.threads += 1; return 'thread-1'; }
}

class Audit implements AuditStore {
  public entries: object[] = [];
  public async append(input: object): Promise<void> { this.entries.push(input); }
}

const firing: MonitoringAlert = {
  source: 'grafana', fingerprint: 'api-5xx', service: 'cubi-api', environment: 'production',
  severity: 'critical', status: 'firing', title: 'API errors', description: '5xx high',
  startedAt: '2026-08-28T07:31:00.000Z',
};

describe('monitoring alert lifecycle', () => {
  it('deduplicates into one message, creates only critical thread, and updates resolved state', async () => {
    const alerts = new Alerts();
    const discord = new Discord();
    const audit = new Audit();
    const service = new MonitoringAlertService(alerts, discord, audit);
    await service.process(firing);
    await service.process(firing);
    await service.process({ ...firing, status: 'resolved' });
    expect(discord.creates).toBe(1);
    expect(discord.threads).toBe(1);
    expect(discord.updates).toBe(2);

    await service.acknowledge('alert-1', 'discord-alice', 'request-1');
    expect(alerts.record?.assignedTo).toBe('discord-alice');
    expect(audit.entries).toHaveLength(1);
  });
});
