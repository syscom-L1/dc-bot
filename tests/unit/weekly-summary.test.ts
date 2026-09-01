import { describe, expect, it } from 'vitest';
import { projectBindingConfigSchema, type ProjectContext, type WorkItem } from '../../src/domain/models.js';
import { renderWeeklySummary } from '../../src/summaries/weekly-summary.js';

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
});
