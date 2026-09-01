import type { Client, Message } from 'discord.js';
import type { Logger } from 'pino';
import { discordErrorMessage } from '../common/errors.js';
import type { AiDiscussionService, DiscussionMessage } from '../ai/discussion-service.js';
import type { DiscordAdapter, GitHubAdapter } from '../domain/adapters.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';
import type { DiscordAccessPolicy } from './access-policy.js';

function asksForAssessment(prompt: string): boolean {
  return /(評估|可不可行|可行性|比較|方案|影響哪些|風險|拆成任務)/u.test(prompt);
}

function toDiscussionMessage(message: Message): DiscussionMessage {
  return {
    author: message.author.globalName ?? message.author.username,
    content: message.content.slice(0, 8_000),
    createdAt: message.createdAt.toISOString(),
    url: message.url,
  };
}

export class DiscordAiDiscussionHandler {
  public constructor(
    private readonly policy: DiscordAccessPolicy,
    private readonly bindings: ProjectBindingStore,
    private readonly github: GitHubAdapter,
    private readonly discord: DiscordAdapter,
    private readonly discussions: AiDiscussionService,
    private readonly googleDocsEnabled: boolean,
    private readonly logger: Logger,
  ) {}

  public register(client: Client): void {
    client.on('messageCreate', (message) => {
      const currentUser = client.user;
      if (!currentUser || message.author.bot || !message.mentions.has(currentUser)) return;
      if (this.googleDocsEnabled && /(文件|docs?|document)/iu.test(message.content)) return;
      void this.handle(message, currentUser.id).catch(async (error: unknown) => {
        this.logger.error({ err: error, messageId: message.id }, 'AI discussion request failed');
        await this.discord.sendChannelMessage(
          message.channelId,
          discordErrorMessage(error, 'AI 討論處理失敗，請稍後再試或聯絡管理員。'),
        );
      });
    });
  }

  private async handle(message: Message, botUserId: string): Promise<void> {
    if (!message.inGuild() || !this.policy.isGuildAllowed(message.guildId)) return;
    const bindingChannelId = message.channel.isThread() ? message.channel.parentId : message.channelId;
    if (!bindingChannelId) return;
    const project = await this.bindings.findByDiscordChannel(message.guildId, bindingChannelId);
    if (!project) {
      await message.reply({
        content: '❌ 這個頻道尚未綁定 GitHub 專案。請管理員到專案頻道執行 `/bot bind-project`。',
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    const prompt = message.content.replaceAll(`<@${botUserId}>`, '').replaceAll(`<@!${botUserId}>`, '').trim();
    if (!prompt) return;

    const refreshTyping = async (): Promise<void> => {
      try {
        await message.channel.sendTyping();
      } catch (error) {
        this.logger.debug({ err: error, messageId: message.id }, 'typing indicator refresh failed');
      }
    };
    await refreshTyping();
    const statusMessage = await message.reply({
      content: '⏳ 正在讀取 GitHub 與整理討論…',
      allowedMentions: { repliedUser: false },
    });
    const typingTimer = setInterval(() => {
      void refreshTyping();
    }, 8_000);
    typingTimer.unref();

    try {
      const recent = message.channel.isTextBased() && 'messages' in message.channel
        ? await message.channel.messages.fetch({ limit: 30 })
        : null;
      const messages = recent
        ? [...recent.values()]
            .filter((item) => !item.author.bot && item.content.length > 0)
            .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
            .map(toDiscussionMessage)
        : [toDiscussionMessage(message)];
      const workItems = await this.github.listWorkItems(project);
      const response = asksForAssessment(prompt)
        ? await this.discussions.assess({ project, prompt, messages, workItems })
        : await this.discussions.summarize({ project, prompt, messages, workItems });
      const [firstChunk, ...remainingChunks] = response;
      if (!firstChunk) throw new Error('AI discussion returned no Discord message chunks');
      await statusMessage.edit({
        content: firstChunk,
        allowedMentions: { parse: [], repliedUser: false },
      });
      for (const chunk of remainingChunks) {
        await this.discord.sendChannelMessage(message.channelId, chunk);
      }
    } catch (error) {
      this.logger.error({ err: error, messageId: message.id }, 'AI discussion request failed');
      try {
        await statusMessage.edit(discordErrorMessage(error, 'AI 討論處理失敗，請稍後再試或聯絡管理員。'));
      } catch (editError) {
        this.logger.error({ err: editError, messageId: message.id }, 'AI discussion status update failed');
        await this.discord.sendChannelMessage(message.channelId, '❌ AI 討論處理失敗，請稍後再試或聯絡管理員。');
      }
    } finally {
      clearInterval(typingTimer);
    }
  }
}
