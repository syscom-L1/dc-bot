import { REST, Routes } from 'discord.js';
import { z } from 'zod';
import type { DiscordAdapter, DiscordButton, DiscordThreadMessage } from '../domain/adapters.js';

const idResponseSchema = z.object({ id: z.string() });
const threadMessagesSchema = z.array(z.object({
  id: z.string(),
  content: z.string(),
  timestamp: z.string(),
  author: z.object({
    id: z.string(),
    username: z.string(),
    global_name: z.string().nullable().optional(),
    bot: z.boolean().optional(),
  }),
}));

const buttonStyles: Record<DiscordButton['style'], number> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
};

export class DiscordRestAdapter implements DiscordAdapter {
  private readonly rest: REST;

  public constructor(token: string) {
    this.rest = new REST({ version: '10' }).setToken(token);
  }

  public async sendChannelMessage(channelId: string, content: string): Promise<string> {
    const response = idResponseSchema.parse(await this.rest.post(Routes.channelMessages(channelId), {
      body: { content, allowed_mentions: { parse: [] } },
    }));
    return response.id;
  }

  public async sendDirectMessage(
    userId: string,
    content: string,
    buttons: DiscordButton[] = [],
  ): Promise<string> {
    const directMessage = idResponseSchema.parse(await this.rest.post(Routes.userChannels(), {
      body: { recipient_id: userId },
    }));
    const components = buttons.length === 0
      ? []
      : [{
          type: 1,
          components: buttons.slice(0, 5).map((button) => ({
            type: 2,
            custom_id: button.customId,
            label: button.label,
            style: buttonStyles[button.style],
          })),
        }];
    const response = idResponseSchema.parse(await this.rest.post(Routes.channelMessages(directMessage.id), {
      body: { content, components, allowed_mentions: { parse: [] } },
    }));
    return response.id;
  }

  public async createThread(input: {
    channelId: string;
    content: string;
    threadName: string;
    mentionUserIds: string[];
  }): Promise<{ messageId: string; threadId: string }> {
    const message = idResponseSchema.parse(await this.rest.post(Routes.channelMessages(input.channelId), {
      body: {
        content: input.content,
        allowed_mentions: { parse: [], users: input.mentionUserIds },
      },
    }));
    const thread = idResponseSchema.parse(await this.rest.post(Routes.threads(input.channelId, message.id), {
      body: {
        name: input.threadName.slice(0, 100),
        auto_archive_duration: 1440,
      },
    }));
    return { messageId: message.id, threadId: thread.id };
  }

  public async listThreadMessages(threadId: string, limit = 100): Promise<DiscordThreadMessage[]> {
    const messages = threadMessagesSchema.parse(await this.rest.get(Routes.channelMessages(threadId), {
      query: new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) }),
    }));
    return messages.map((message) => ({
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.global_name ?? message.author.username,
      content: message.content,
      createdAt: message.timestamp,
      isBot: message.author.bot ?? false,
    }));
  }

  public async checkConnection(): Promise<void> {
    await this.rest.get(Routes.user('@me'));
  }
}
