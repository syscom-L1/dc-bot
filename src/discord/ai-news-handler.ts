import type { Client, Message } from 'discord.js';
import type { Logger } from 'pino';
import type { QueueAdapter } from '../domain/adapters.js';
import type { AiNewsStore } from '../persistence/contracts.js';
import { extractHttpsUrls } from '../ai-news/url.js';
import type { DiscordAccessPolicy } from './access-policy.js';

export class DiscordAiNewsHandler {
	public constructor(
		private readonly policy: DiscordAccessPolicy,
		private readonly store: AiNewsStore,
		private readonly queues: QueueAdapter,
		private readonly maxLinks: number,
		private readonly logger: Logger,
	) {}

	public register(client: Client): void {
		client.on('messageCreate', (message) => {
			if (message.author.bot) return;
			void this.handle(message).catch((error: unknown) => {
				this.logger.error({ err: error, messageId: message.id }, 'AI news link enqueue failed');
			});
		});
	}

	private async handle(message: Message): Promise<void> {
		if (!message.inGuild() || !this.policy.isGuildAllowed(message.guildId)) return;
		const setting = await this.store.findAiNewsSetting(message.guildId);
		if (!setting?.enabled || setting.discordChannelId !== message.channelId) return;
		const urls = extractHttpsUrls(message.content, this.maxLinks);
		if (urls.length === 0) return;
		await this.queues.enqueue(
			'ai-news-link-summary',
			'summarize',
			{
				guildId: message.guildId,
				channelId: message.channelId,
				messageId: message.id,
				userId: message.author.id,
				urls,
			},
			{ jobId: `ai-news-link-${message.id}`, attempts: 3 },
		);
	}
}
