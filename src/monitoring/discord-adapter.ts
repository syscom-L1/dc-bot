import { REST, Routes } from 'discord.js';
import { z } from 'zod';
import type { AlertRecord, MonitoringDiscordAdapter } from './alert-service.js';

const idSchema = z.object({ id: z.string() });

function components(alert: AlertRecord) {
  if (alert.status === 'resolved') return [];
  return [{
    type: 1,
    components: [
      { type: 2, custom_id: `monitoring:ack:${alert.id}`, label: '我來處理', style: 1, disabled: Boolean(alert.assignedTo) },
      { type: 2, custom_id: `monitoring:mute:${alert.id}`, label: '靜音 30 分鐘', style: 2 },
      ...(alert.mutedUntil ? [{ type: 2, custom_id: `monitoring:resume:${alert.id}`, label: '恢復通知', style: 3 }] : []),
    ],
  }];
}

export class DiscordMonitoringAdapter implements MonitoringDiscordAdapter {
  private readonly rest: REST;

  public constructor(token: string, private readonly channelId: string) {
    this.rest = new REST({ version: '10' }).setToken(token);
  }

  public async createAlert(content: string, alert: AlertRecord): Promise<string> {
    const response = idSchema.parse(await this.rest.post(Routes.channelMessages(this.channelId), {
      body: { content, components: components(alert), allowed_mentions: { parse: [] } },
    }));
    return response.id;
  }

  public async updateAlert(messageId: string, content: string, alert: AlertRecord): Promise<void> {
    await this.rest.patch(Routes.channelMessage(this.channelId, messageId), {
      body: { content, components: components(alert), allowed_mentions: { parse: [] } },
    });
  }

  public async createCriticalThread(messageId: string, name: string): Promise<string> {
    const response = idSchema.parse(await this.rest.post(Routes.threads(this.channelId, messageId), {
      body: { name, auto_archive_duration: 1_440 },
    }));
    return response.id;
  }
}
