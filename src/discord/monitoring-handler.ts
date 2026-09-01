import { randomUUID } from 'node:crypto';
import type { ButtonInteraction, Client } from 'discord.js';
import type { Logger } from 'pino';
import type { MonitoringAlertService } from '../monitoring/alert-service.js';
import type { DiscordAccessPolicy } from './access-policy.js';

export class DiscordMonitoringHandler {
  public constructor(
    private readonly policy: DiscordAccessPolicy,
    private readonly alerts: MonitoringAlertService,
    private readonly logger: Logger,
  ) {}

  public register(client: Client): void {
    client.on('interactionCreate', (interaction) => {
      if (!interaction.isButton() || !interaction.customId.startsWith('monitoring:')) return;
      void this.handle(interaction).catch(async (error: unknown) => {
        this.logger.error({ err: error, interactionId: interaction.id }, 'monitoring interaction failed');
        const content = error instanceof Error ? error.message : '告警操作失敗';
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
        else await interaction.reply({ content, ephemeral: true });
      });
    });
  }

  private async handle(interaction: ButtonInteraction): Promise<void> {
    if (!this.policy.isGuildAllowed(interaction.guildId)) return;
    const [, action, id] = interaction.customId.split(':');
    if (!action || !id) return;
    const requestId = randomUUID();
    if (action === 'ack') await this.alerts.acknowledge(id, interaction.user.id, requestId);
    else if (action === 'mute') await this.alerts.mute(id, interaction.user.id, 30, requestId);
    else if (action === 'resume') await this.alerts.resume(id, interaction.user.id, requestId);
    await interaction.reply({ content: '告警狀態已更新。', ephemeral: true });
  }
}
