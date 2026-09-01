import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { Logger } from 'pino';
import type { DiscordInteractionHandler } from './interaction-handler.js';

export class DiscordGateway {
  public readonly client: Client;

  public constructor(
    private readonly token: string,
    handler: DiscordInteractionHandler,
    private readonly logger: Logger,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    handler.register(this.client);
    this.client.once(Events.ClientReady, (client) => this.logger.info({ user: client.user.tag }, 'Discord bot connected'));
    this.client.on('error', (error) => this.logger.error({ err: error }, 'Discord client error'));
    this.client.on('shardDisconnect', (event, shardId) => this.logger.warn({ code: event.code, shardId }, 'Discord shard disconnected'));
    this.client.on('shardReconnecting', (shardId) => this.logger.info({ shardId }, 'Discord shard reconnecting'));
  }

  public async start(): Promise<void> {
    await this.client.login(this.token);
  }

  public async close(): Promise<void> {
    await this.client.destroy();
  }
}
