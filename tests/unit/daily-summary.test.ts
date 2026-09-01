import { describe, expect, it } from 'vitest';
import { projectBindingConfigSchema, type ProjectContext, type WorkItem } from '../../src/domain/models.js';
import { renderDailySummary, splitDiscordMessage } from '../../src/summaries/daily-summary.js';

const project: ProjectContext = {
  bindingId: 'binding',
  name: 'CUBI',
  discordGuildId: 'guild',
  discordChannelId: 'channel',
  summaryChannelId: 'summary',
  githubOrganization: 'acme',
  githubProjectId: 'PVT_1',
  githubInstallationId: '123',
  repositories: [{ id: 'repository', owner: 'acme', name: 'api' }],
  config: projectBindingConfigSchema.parse({}),
};

describe('daily summary', () => {
  it('groups risks without ranking people', () => {
    const item: WorkItem = {
      providerItemId: 'I_1',
      type: 'issue',
      owner: 'acme',
      repository: 'api',
      number: 183,
      title: 'Docling Fallback',
      url: 'https://github.com/acme/api/issues/183',
      state: 'open',
      assignees: ['alice'],
      status: 'In Progress',
      targetDate: new Date('2026-08-30T15:59:59.999Z'),
      updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    };
    const messages = renderDailySummary(
      project,
      [item],
      new Date('2026-08-28T04:00:00.000Z'),
      'Asia/Taipei',
      { dueSoonDays: 3, inactivityHours: 48, reviewWaitHours: 24 },
    );
    expect(messages.join('\n')).toContain('進行中');
    expect(messages.join('\n')).toContain('即將到期且缺少活動');
    expect(messages.join('\n')).not.toContain('排行榜');
  });

  it('splits content below Discord limits', () => {
    const chunks = splitDiscordMessage(`${'a'.repeat(1_000)}\n\n${'b'.repeat(1_000)}`, 1_200);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
  });
});
