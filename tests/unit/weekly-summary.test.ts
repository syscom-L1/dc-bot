import { describe, expect, it, vi } from 'vitest';
import { projectBindingConfigSchema, type ProjectContext, type WorkItem } from '../../src/domain/models.js';
import type { DiscordAdapter, GitHubAdapter } from '../../src/domain/adapters.js';
import type { ProjectBindingStore } from '../../src/persistence/contracts.js';
import type { CommitHistorySummaryService } from '../../src/summaries/commit-history-summary.js';
import { renderWeeklySummary, WeeklySummaryService } from '../../src/summaries/weekly-summary.js';

const project: ProjectContext = {
  bindingId: 'binding',
  name: 'CUBI',
  discordGuildId: 'guild',
  discordChannelId: 'channel',
  summaryChannelId: 'summary',
  githubOrganization: 'acme',
  githubInstallationId: '123',
  repositories: [],
  config: projectBindingConfigSchema.parse({}),
};

describe('weekly summary', () => {
  it('groups task outcomes and risks without productivity rankings', () => {
    const item: WorkItem = {
      providerItemId: 'I_1',
      type: 'issue',
      owner: 'acme',
      repository: 'api',
      number: 1,
      title: 'Finish vertical slice',
      url: 'https://github.com/acme/api/issues/1',
      state: 'open',
      assignees: ['alice'],
      status: 'Blocked',
      startDate: new Date('2026-08-25T15:59:59.999Z'),
      targetDate: new Date('2026-08-27T15:59:59.999Z'),
      updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    };
    const output = renderWeeklySummary(project, [item], new Date('2026-08-28T04:00:00.000Z'), 48).join('\n');
    expect(output).toContain('本週預定工作');
    expect(output).toContain('已逾期');
    expect(output).toContain('阻塞事項');
    expect(output).toContain('缺少進度資訊');
    expect(output).not.toContain('Commit 數量');
    expect(output).not.toContain('排行榜');
  });

	it('appends the AI commit summary to the weekly report', async () => {
		const sent: string[] = [];
		const discord = {
			sendChannelMessage: vi.fn(async (_channelId: string, content: string) => {
				sent.push(content);
				return `message-${sent.length}`;
			}),
		} as unknown as DiscordAdapter;
		const commitHistory = {
			summarize: vi.fn().mockResolvedValue({
				status: 'complete', overview: '完成 API 調整。', warnings: [],
				repositories: [{ repository: 'acme/api', changes: [{
					summary: '調整 API', sources: [{ sha: 'abcdef123', url: 'https://github.com/acme/api/commit/abcdef123' }],
				}] }],
			}),
		} as unknown as CommitHistorySummaryService;
		const service = new WeeklySummaryService(
			{ listActive: vi.fn().mockResolvedValue([{ ...project, summaryChannelId: 'summary' }]) } as unknown as ProjectBindingStore,
			{ listWorkItems: vi.fn().mockResolvedValue([]) } as unknown as GitHubAdapter,
			discord,
			48,
			commitHistory,
		);

		await expect(service.run(new Date('2026-09-04T08:00:00.000Z'))).resolves.toBe(2);
		expect(sent.join('\n')).toContain('程式碼變更摘要');
		expect(sent.join('\n')).toContain('調整 API');
	});
});
