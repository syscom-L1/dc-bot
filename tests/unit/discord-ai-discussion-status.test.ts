import type { Client, Message } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AiDiscussionService } from '../../src/ai/discussion-service.js';
import type { DiscordAdapter, GitHubAdapter } from '../../src/domain/adapters.js';
import { projectBindingConfigSchema, type ProjectContext } from '../../src/domain/models.js';
import type { ProjectBindingStore } from '../../src/persistence/contracts.js';
import type { DiscordAccessPolicy } from '../../src/discord/access-policy.js';
import { DiscordAiDiscussionHandler, resolveDiscussionIntent } from '../../src/discord/ai-discussion-handler.js';

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
  it('answers an ordinary question, inherits the thread binding and replaces the processing message', async () => {
    const editStatus = vi.fn(async () => undefined);
    const reply = vi.fn(async () => ({ edit: editStatus }));
    const sendTyping = vi.fn(async () => undefined);
    const messages = new Map<string, Message>();
    const fetchMessages = vi.fn(async () => messages);
		const findByDiscordChannel = vi.fn(async () => project);
		const answer = vi.fn(async () => ['## 回答完成']);
    const sourceMessage = {
      id: 'message',
      guildId: 'guild',
      channelId: 'thread',
      content: '<@bot> 這個錯誤可能是什麼原因？',
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
        parentId: 'channel',
        isThread: () => true,
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
        findByDiscordChannel,
      } as unknown as ProjectBindingStore,
      {
        listWorkItems: vi.fn(async () => []),
      } as unknown as GitHubAdapter,
      {
        sendChannelMessage: vi.fn(async () => undefined),
      } as unknown as DiscordAdapter,
      {
				answer,
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
        content: '## 回答完成',
        allowedMentions: { parse: [], repliedUser: false },
      });
    });
		expect(answer).toHaveBeenCalledOnce();
		expect(findByDiscordChannel).toHaveBeenCalledWith('guild', 'channel');
    expect(sendTyping).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: '⏳ 正在查閱討論與 GitHub 狀態…',
      allowedMentions: { repliedUser: false },
    });
  });

	it('未綁定專案時回覆設定指引且不呼叫 LLM', async () => {
		const reply = vi.fn(async () => undefined);
		const answer = vi.fn(async () => ['不應被呼叫']);
		const sourceMessage = {
			id: 'unbound-message',
			guildId: 'guild',
			channelId: 'unbound-channel',
			content: '<@bot> 這個錯誤是什麼原因？',
			author: { bot: false },
			mentions: { has: () => true },
			inGuild: () => true,
			reply,
			channel: {
				parentId: null,
				isThread: () => false,
			},
		} as unknown as Message;
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
			{ findByDiscordChannel: vi.fn(async () => null) } as unknown as ProjectBindingStore,
			{ listWorkItems: vi.fn(async () => []) } as unknown as GitHubAdapter,
			{ sendChannelMessage: vi.fn(async () => undefined) } as unknown as DiscordAdapter,
			{
				answer,
				summarize: vi.fn(async () => []),
				assess: vi.fn(async () => []),
			} as unknown as AiDiscussionService,
			false,
			pino({ level: 'silent' }),
		);

		handler.register(client);
		if (!listener) throw new Error('messageCreate listener was not registered');
		listener(sourceMessage);

		await vi.waitFor(() => {
			expect(reply).toHaveBeenCalledWith({
				content: '❌ 這個頻道尚未綁定 GitHub 專案。請管理員到專案頻道執行 `/bot bind-project`。',
				allowedMentions: { repliedUser: false },
			});
		});
		expect(answer).not.toHaveBeenCalled();
	});
});

describe('Discord AI discussion intent', () => {
	it.each([
		['這個錯誤可能是什麼原因？', 'answer'],
		['這個方案的重點是什麼？', 'answer'],
		['幫我整理目前討論重點', 'summary'],
		['評估這個功能可不可行', 'assessment'],
		['幫我整理這個方案的風險', 'assessment'],
	] as const)('將「%s」判斷為 %s', (prompt, expected) => {
		expect(resolveDiscussionIntent(prompt)).toBe(expected);
	});
});
