import { describe, expect, it } from 'vitest';
import type { ProjectContext } from '../../src/domain/models.js';
import { repositoryPickerRows, setupWizardRows, setupWizardText } from '../../src/discord/setup-wizard.js';

const baseProject: ProjectContext = {
  bindingId: '671d5177-e303-425b-a7dd-80692540a8d9',
  name: 'syscom',
  discordGuildId: 'guild-1',
  discordChannelId: 'project-channel',
  githubOrganization: 'powei-888',
  githubInstallationId: '100',
  repositories: [],
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

describe('Discord setup wizard', () => {
  it('shows one concrete next step when no project exists', () => {
    const input = { projects: [], peopleCount: 0 };
    expect(setupWizardText(input)).toContain('0/4 完成');
    expect(setupWizardText(input)).toContain('按「建立第一個專案」');
    expect(JSON.stringify(setupWizardRows(input).map((row) => row.toJSON()))).toContain('setup:project:new');
  });

  it('moves from repository to summary to member and unlocks tests at 4/4', () => {
    const repositoryNext = setupWizardText({ projects: [baseProject], selectedProject: baseProject, peopleCount: 0 });
    expect(repositoryNext).toContain('1/4 完成');
    expect(repositoryNext).toContain('按「選擇 Repository」');

    const withRepository: ProjectContext = {
      ...baseProject,
      repositories: [{ id: 'repo-1', owner: 'powei-888', name: 'CUBI' }],
    };
    expect(setupWizardText({ projects: [withRepository], selectedProject: withRepository, peopleCount: 0 }))
      .toContain('按「設定工作摘要」');

    const complete: ProjectContext = { ...withRepository, summaryChannelId: 'summary-channel' };
    const input = { projects: [complete], selectedProject: complete, peopleCount: 2 };
    expect(setupWizardText(input)).toContain('4/4 完成');
    expect(setupWizardText(input)).toContain('已可日常使用');
    const components = setupWizardRows(input).flatMap((row) => row.toJSON().components);
    const reminder = components.find((component) => 'custom_id' in component && component.custom_id.startsWith('setup:report-open'));
    expect(reminder).toEqual(expect.objectContaining({ disabled: false }));
  });

  it('paginates repository choices and supports multi-select', () => {
    const repositories = Array.from({ length: 30 }, (_, index) => ({
      id: String(index + 1),
      owner: 'acme',
      name: `repo-${index + 1}`,
      fullName: `acme/repo-${index + 1}`,
      private: index % 2 === 0,
    }));
    const rows = repositoryPickerRows({
      projectId: baseProject.bindingId,
      installationId: '100',
      repositories,
      page: 0,
    });
    const json = rows.map((row) => row.toJSON());
    expect(json[0]?.components[0]).toEqual(expect.objectContaining({ min_values: 1, max_values: 25 }));
    expect(JSON.stringify(json)).toContain('setup:repo-page');
    expect(JSON.stringify(json)).toContain('下一頁');
  });
});
