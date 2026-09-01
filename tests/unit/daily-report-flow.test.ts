import { describe, expect, it, vi } from 'vitest';
import type { LlmAdapter } from '../../src/ai/contracts.js';
import {
  DailyReportReminderService,
  DailyReportSummaryService,
  renderDailyReportSummary,
} from '../../src/daily-reports/daily-report-service.js';
import type { DiscordAdapter, GitHubAdapter } from '../../src/domain/adapters.js';
import { repositoryInstallationId, type ProjectContext } from '../../src/domain/models.js';
import type { DailyReportStore, PersonStore, ProjectBindingStore } from '../../src/persistence/contracts.js';

const project: ProjectContext = {
  bindingId: '671d5177-e303-425b-a7dd-80692540a8d9',
  name: 'syscom',
  discordGuildId: 'guild-1',
  discordChannelId: 'project-channel',
  summaryChannelId: 'summary-channel',
  leaveChannelId: 'leave-channel',
  githubOrganization: 'powei-888',
  githubInstallationId: '100',
  repositories: [
    { id: 'repo-a', owner: 'powei-888', name: 'main', githubInstallationId: '100' },
    { id: 'repo-b', owner: 'alice', name: 'service', githubInstallationId: '200' },
  ],
  config: {
    githubProjectFields: {
      status: 'Status', priority: 'Priority', startDate: 'Start Date',
      targetDate: 'Target Date', iteration: 'Iteration',
    },
    statusOptions: {
      backlog: 'Backlog', ready: 'Ready', inProgress: 'In Progress',
      review: 'Review', blocked: 'Blocked', done: 'Done',
    },
    autoUpdateGithubStatus: false,
    dueSoonDays: 3,
    inactivityHours: 48,
  },
};

const rules = { dueSoonDays: 3, inactivityHours: 48, reviewWaitHours: 24 };

describe('daily report flow', () => {
  it('opens one reminder thread and mentions linked members at 16:30', async () => {
    const createThread = vi.fn(async (_input: {
      channelId: string; content: string; threadName: string; mentionUserIds: string[];
    }) => {
      void _input;
      return { messageId: 'reminder-1', threadId: 'thread-1' };
    });
    const markOpened = vi.fn().mockResolvedValue(undefined);
    const discord = {
      createThread,
      sendChannelMessage: vi.fn().mockResolvedValue('preview-1'),
    } as unknown as DiscordAdapter;
    const reports = {
      getOrCreateDailyReport: vi.fn().mockResolvedValue({
        id: 'session-1', projectBindingId: project.bindingId, reportDate: '2026-08-28',
        status: 'OPENING', discordChannelId: 'summary-channel', reminderMessageId: null,
        discordThreadId: null, expectedDiscordUserIds: ['user-1', 'user-2'],
        responseSnapshot: null, summarySnapshot: null, closesAt: new Date(),
      }),
      markDailyReportOpened: markOpened,
    } as unknown as DailyReportStore;
    const service = new DailyReportReminderService(
      { listActive: vi.fn().mockResolvedValue([
          project,
          { ...project, bindingId: 'other-project', name: 'other', summaryChannelId: 'other-summary' },
        ]) } as unknown as ProjectBindingStore,
      {
        listEnabled: vi.fn().mockResolvedValue([
          { id: 'p1', displayName: 'A', discordUserId: 'user-1', githubLogin: 'a', timezone: 'Asia/Taipei', enabled: true },
          { id: 'p2', displayName: 'B', discordUserId: 'user-2', githubLogin: 'b', timezone: 'Asia/Taipei', enabled: true },
        ]),
      } as unknown as PersonStore,
      reports,
      { listWorkItems: vi.fn().mockResolvedValue([]) } as unknown as GitHubAdapter,
      discord,
      'Asia/Taipei',
      rules,
      { warn: vi.fn() } as never,
    );

    await expect(service.run(new Date('2026-08-28T08:30:00.000Z'), project.bindingId)).resolves.toBe(1);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'summary-channel',
      threadName: '2026-08-28 syscom 工作回報',
      mentionUserIds: ['user-1', 'user-2'],
    }));
    expect(createThread.mock.calls[0]?.[0].content).toContain('<@user-1> <@user-2>');
    expect(markOpened).toHaveBeenCalledWith('session-1', 'reminder-1', 'thread-1', expect.any(Date));
  });

  it('summarizes replies without publicly naming non-reporters', async () => {
    const markSummarized = vi.fn().mockResolvedValue(undefined);
    const sent: string[] = [];
    const discord = {
      listThreadMessages: vi.fn().mockResolvedValue([
        { id: 'm1', authorId: 'user-1', authorName: 'Alice', content: '完成 API，明天補測試', createdAt: '2026-08-28T08:45:00.000Z', isBot: false },
        { id: 'm2', authorId: 'bot', authorName: 'Bot', content: 'GitHub snapshot', createdAt: '2026-08-28T08:31:00.000Z', isBot: true },
      ]),
      sendChannelMessage: vi.fn(async (_channelId: string, message: string) => {
        sent.push(message);
        return `sent-${sent.length}`;
      }),
    } as unknown as DiscordAdapter;
    const reports = {
      listOpenDailyReportsThrough: vi.fn().mockResolvedValue([{
        id: 'session-1', projectBindingId: project.bindingId, reportDate: '2026-08-28',
        status: 'OPEN', discordChannelId: 'summary-channel', reminderMessageId: 'reminder-1',
        discordThreadId: 'thread-1', expectedDiscordUserIds: ['user-1', 'user-2'],
        responseSnapshot: null, summarySnapshot: null, closesAt: new Date(),
      }]),
      markDailyReportSummarized: markSummarized,
    } as unknown as DailyReportStore;
    const llm = {
      generateStructured: vi.fn().mockResolvedValue({
        data: {
          overview: 'API 開發持續進行。',
          memberUpdates: [{
            authorName: 'Alice', completed: ['完成 API'], inProgress: [], blockers: [], nextSteps: ['補測試'],
          }],
          blockers: [], nextActions: ['補齊測試'], unknowns: [],
        },
        model: 'test', traceId: 'trace',
      }),
    } as unknown as LlmAdapter;
    const service = new DailyReportSummaryService(
      { findProjectById: vi.fn().mockResolvedValue(project) } as unknown as ProjectBindingStore,
      reports,
      { listWorkItems: vi.fn().mockResolvedValue([]) } as unknown as GitHubAdapter,
      discord,
      llm,
      'Asia/Taipei',
      rules,
    );

    await expect(service.run(new Date('2026-08-28T09:00:00.000Z'))).resolves.toBe(1);
    expect(sent.join('\n')).toContain('回報狀態：1/2');
    expect(sent.join('\n')).toContain('未回報者僅計入數量，不公開點名');
    expect(markSummarized).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      responses: [expect.objectContaining({ authorId: 'user-1' })],
    }));
  });

  it('renders a neutral report count and resolves per-repository installations', () => {
    const rendered = renderDailyReportSummary({
      reportDate: '2026-08-28', projectName: 'syscom', expectedCount: 3, reportedCount: 1,
      summary: { overview: '進行中', memberUpdates: [], blockers: [], nextActions: [], unknowns: [] },
    }).join('\n');
    expect(rendered).toContain('1/3');
    expect(rendered).not.toContain('未填名單');
    expect(repositoryInstallationId(project, 'alice', 'service')).toBe('200');
    expect(repositoryInstallationId(project, 'powei-888', 'main')).toBe('100');
  });
});
