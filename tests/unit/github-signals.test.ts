import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../../src/domain/models.js';
import { enrichGitHubSignals } from '../../src/github/enrich-signals.js';

describe('GitHub Actions and Review enrichment', () => {
  it('maps the latest workflow run and reviewer states onto open pull requests', async () => {
    const octokit = {
      rest: {
        actions: {
          listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [{
            status: 'completed', conclusion: 'failure', pull_requests: [{ number: 10 }],
          }] } }),
        },
        pulls: {
          listReviews: async () => ({ data: [{ user: { login: 'reviewer' }, state: 'APPROVED' }] }),
        },
      },
    } as unknown as Octokit;
    const item: WorkItem = {
      providerItemId: 'PR_10', type: 'pull_request', owner: 'acme', repository: 'api', number: 10,
      title: 'Feature', url: 'https://github.com/acme/api/pull/10', state: 'open', assignees: ['alice'],
      updatedAt: new Date('2026-08-28T00:00:00Z'),
    };
    const result = await enrichGitHubSignals(octokit, [item]);
    expect(result[0]?.workflowState).toBe('failure');
    expect(result[0]?.reviewState).toBe('approved');
  });
});
