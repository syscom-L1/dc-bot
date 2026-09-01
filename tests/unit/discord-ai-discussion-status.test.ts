import type { Client, Message } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AiDiscussionService } from '../../src/ai/discussion-service.js';
import type { DiscordAdapter, GitHubAdapter } from '../../src/domain/adapters.js';
import { projectBindingConfigSchema, type ProjectContext } from '../../src/domain/models.js';
import type { ProjectBindingStore } from '../../src/persistence/contracts.js';
import type { DiscordAccessPolicy } from '../../src/discord/access-policy.js';
import { DiscordAiDiscussionHandler } from '../../src/discord/ai-discussion-handler.js';

const project: ProjectContext = {
  bindingId: 'binding',
  name: 'syscom',
  discordGuildId: 'guild',
  discordChannelId: 'channel',
  githubOrganization: 'powei-888',
  githubInstallationId: '123',
  repositories: [],
  config: projectBindingConfigSchema.parse({}),
};

describe('Discord AI discussion status', () => {
  it('shows typing and replaces the processing message with the result', async () => {
    const editStatus = vi.fn(async () => undefined);
    const reply = vi.fn(async () => ({ edit: editStatus }));
    const sendTyping = vi.fn(async () => undefined);
    const messages = new Map<string, Message>();
    const fetchMessages = vi.fn(async () => messages);
    const sourceMessage = {
      id: 'message',
      guildId: 'guild',
      channelId: 'channel',
      content: '<@bot> 幫我整理目前頻道的討論重點',
      author: {
        bot: false,
        globalName: 'Alice',
        username: 'alice',
      },
      mentions: { has: () => true },
      createdAt: new Date('2026-08-28T09:00:00Z'),
      createdTimestamp: Date.parse('2026-08-28T09:00:00Z'),
      url: 'https://discord.test/message',
      inGuild: () => true,
      reply,
      channel: {
        parentId: null,
        isThread: () => false,
        isTextBased: () => true,
        sendTyping,
        messages: { fetch: fetchMessages },
      },
    } as unknown as Message;
    messages.set('message', sourceMessage);

    let listener: ((message: Message) => void) | undefined;
    const client = {
      user: { id: 'bot' },
      on: vi.fn((_event: string, callback: (message: Message) => void) => {
        listener = callback;
        return client;
      }),
    } as unknown as Client;
    const handler = new DiscordAiDiscussionHandler(
      { isGuildAllowed: () => true } as unknown as DiscordAccessPolicy,
      {
        findByDiscordChannel: vi.fn(async () => project),
      } as unknown as ProjectBindingStore,
      {
        listWorkItems: vi.fn(async () => []),
      } as unknown as GitHubAdapter,
      {
        sendChannelMessage: vi.fn(async () => undefined),
      } as unknown as DiscordAdapter,
      {
        summarize: vi.fn(async () => ['## 討論整理完成']),
        assess: vi.fn(async () => ['## 可行性評估完成']),
      } as unknown as AiDiscussionService,
      false,
      pino({ level: 'silent' }),
    );

    handler.register(client);
    if (!listener) throw new Error('messageCreate listener was not registered');
    listener(sourceMessage);

    await vi.waitFor(() => {
      expect(editStatus).toHaveBeenCalledWith({
        content: '## 討論整理完成',
        allowedMentions: { parse: [], repliedUser: false },
      });
    });
    expect(sendTyping).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: '⏳ 正在讀取 GitHub 與整理討論…',
      allowedMentions: { repliedUser: false },
    });
  });
});
