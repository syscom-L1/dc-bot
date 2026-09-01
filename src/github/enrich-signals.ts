import type { Octokit } from '@octokit/rest';
import type { WorkItem } from '../domain/models.js';

function repositoryKey(item: WorkItem): string {
  return `${item.owner}/${item.repository}`;
}

export async function enrichGitHubSignals(octokit: Octokit, items: WorkItem[]): Promise<WorkItem[]> {
  const repositories = new Map<string, { owner: string; repository: string }>();
  for (const item of items) repositories.set(repositoryKey(item), { owner: item.owner, repository: item.repository });

  for (const [key, repository] of repositories) {
    const repositoryItems = items.filter((item) => repositoryKey(item) === key);
    const openPulls = repositoryItems.filter((item) => item.type === 'pull_request' && item.state === 'open');

    const workflowRuns = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner: repository.owner,
      repo: repository.repository,
      per_page: 100,
    });
    const workflowByPull = new Map<number, WorkItem['workflowState']>();
    for (const run of workflowRuns.data.workflow_runs) {
      const state: WorkItem['workflowState'] = run.status !== 'completed'
        ? 'pending'
        : run.conclusion === 'success' ? 'success'
          : run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'cancelled'
            ? 'failure'
            : 'unknown';
      for (const pull of run.pull_requests ?? []) {
        if (!workflowByPull.has(pull.number)) workflowByPull.set(pull.number, state);
      }
    }
    for (const item of openPulls) item.workflowState = workflowByPull.get(item.number) ?? 'unknown';

    await Promise.all(openPulls.map(async (item) => {
      const reviews = await octokit.rest.pulls.listReviews({
        owner: item.owner,
        repo: item.repository,
        pull_number: item.number,
        per_page: 100,
      });
      const latestByReviewer = new Map<string, string>();
      for (const review of reviews.data) {
        const reviewer = review.user?.login;
        if (reviewer) latestByReviewer.set(reviewer, review.state.toUpperCase());
      }
      const states = [...latestByReviewer.values()];
      item.reviewState = states.includes('CHANGES_REQUESTED')
        ? 'changes_requested'
        : states.includes('APPROVED') ? 'approved' : 'pending';
    }));
  }
  return items;
}
