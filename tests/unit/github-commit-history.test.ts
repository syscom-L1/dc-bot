import { describe, expect, it, vi } from 'vitest';
import { projectBindingConfigSchema, type ProjectContext } from '../../src/domain/models.js';
import {
	collectCommitActivities,
	type GitHubCommitClient,
	type GitHubCommitRecord,
	isEmptyRepositoryError,
} from '../../src/github/commit-history.js';

const window = {
	since: new Date('2026-08-31T16:00:00.000Z'),
	until: new Date('2026-09-01T09:00:00.000Z'),
};

function project(repositories: ProjectContext['repositories']): ProjectContext {
	return {
		bindingId: 'binding',
		name: 'Team',
		discordGuildId: 'guild',
		discordChannelId: 'channel',
		githubOrganization: 'acme',
		githubInstallationId: '100',
		repositories,
		config: projectBindingConfigSchema.parse({}),
	};
}

function commit(input: Partial<GitHubCommitRecord> & { sha: string }): GitHubCommitRecord {
	return {
		sha: input.sha,
		url: input.url ?? `https://github.com/acme/api/commit/${input.sha}`,
		message: input.message ?? `Change ${input.sha}`,
		committedAt: input.committedAt ?? '2026-09-01T08:00:00.000Z',
		parentCount: input.parentCount ?? 1,
		authorLogin: input.authorLogin ?? 'alice',
		authorType: input.authorType ?? 'User',
		committerLogin: input.committerLogin ?? 'alice',
		committerType: input.committerType ?? 'User',
	};
}

describe('GitHub commit history collector', () => {
	it('recognizes only GitHub empty repository conflicts as an empty result', () => {
		expect(isEmptyRepositoryError(Object.assign(new Error('Git Repository is empty.'), { status: 409 }))).toBe(true);
		expect(isEmptyRepositoryError(Object.assign(new Error('Conflict'), { status: 409 }))).toBe(false);
		expect(isEmptyRepositoryError(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe(false);
	});

	it('queries every branch across installations, filters noise, and deduplicates SHAs', async () => {
		const calls: string[] = [];
		const primary: GitHubCommitClient = {
			listBranches: vi.fn(async () => ['main', 'feature/api']),
			listCommits: vi.fn(async ({ branch }: Parameters<GitHubCommitClient['listCommits']>[0]) => {
				calls.push(branch);
				if (branch === 'main') {
					return [
						commit({ sha: 'shared' }),
						commit({ sha: 'merge', parentCount: 2 }),
						commit({ sha: 'bot', authorLogin: 'dependabot[bot]', authorType: 'Bot' }),
					];
				}
				return [commit({ sha: 'shared' }), commit({ sha: 'feature' })];
			}),
		};
		const secondary: GitHubCommitClient = {
			listBranches: vi.fn(async () => ['develop']),
			listCommits: vi.fn(async ({ branch }: Parameters<GitHubCommitClient['listCommits']>[0]) => {
				calls.push(branch);
				return [commit({ sha: 'service', url: 'https://github.com/acme/service/commit/service' })];
			}),
		};
		const getClient = vi.fn(async (installationId: string) => installationId === '200' ? secondary : primary);

		const result = await collectCommitActivities({
			context: project([
				{ id: 'api', owner: 'acme', name: 'api' },
				{ id: 'service', owner: 'acme', name: 'service', githubInstallationId: '200' },
			]),
			window,
			getClient,
		});

		expect(getClient).toHaveBeenCalledTimes(2);
		expect(calls.sort()).toEqual(['develop', 'feature/api', 'main']);
		expect(result.commits.map((item) => item.sha).sort()).toEqual(['feature', 'service', 'shared']);
		expect(result.commits.find((item) => item.sha === 'shared')?.branches).toEqual(['feature/api', 'main']);
		expect(result.warnings).toEqual([]);
	});

	it('keeps successful data and stops querying the rest of a rate-limited installation', async () => {
		const rateLimit = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
		const listCommits = vi.fn(async ({ repository }: Parameters<GitHubCommitClient['listCommits']>[0]) => {
			if (repository === 'api') throw rateLimit;
			return [commit({ sha: 'should-not-run' })];
		});
		const client: GitHubCommitClient = {
			listBranches: vi.fn(async () => ['main']),
			listCommits,
		};

		const result = await collectCommitActivities({
			context: project([
				{ id: 'api', owner: 'acme', name: 'api' },
				{ id: 'service', owner: 'acme', name: 'service' },
			]),
			window,
			getClient: vi.fn(async () => client),
		});

		expect(listCommits).toHaveBeenCalledTimes(1);
		expect(result.commits).toEqual([]);
		expect(result.warnings).toEqual([
			{ repository: 'acme/api', reason: 'rate_limited' },
			{ repository: 'acme/service', reason: 'rate_limited' },
		]);
	});

	it('keeps partial results when one branch fails and runs at most four branch queries concurrently', async () => {
		let active = 0;
		let maximumActive = 0;
		const client: GitHubCommitClient = {
			listBranches: vi.fn(async () => ['main', 'feature/a', 'feature/b', 'feature/c', 'feature/d', 'broken']),
			listCommits: vi.fn(async ({ branch }: Parameters<GitHubCommitClient['listCommits']>[0]) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active -= 1;
				if (branch === 'broken') throw new Error('branch unavailable');
				return [commit({ sha: branch })];
			}),
		};

		const result = await collectCommitActivities({
			context: project([{ id: 'api', owner: 'acme', name: 'api' }]),
			window,
			getClient: vi.fn(async () => client),
		});

		expect(maximumActive).toBe(4);
		expect(result.commits).toHaveLength(5);
		expect(result.warnings).toEqual([{ repository: 'acme/api', reason: 'branch_query_failed' }]);
	});

	it('returns an empty complete result for an empty repository', async () => {
		const result = await collectCommitActivities({
			context: project([{ id: 'empty', owner: 'acme', name: 'empty' }]),
			window,
			getClient: vi.fn(async () => ({
				listBranches: vi.fn(async () => []),
				listCommits: vi.fn(async () => []),
			})),
		});

		expect(result).toEqual({ commits: [], warnings: [], truncated: false });
	});

	it('caps busy repositories and balances the project result', async () => {
		const client: GitHubCommitClient = {
			listBranches: vi.fn(async () => ['main']),
			listCommits: vi.fn(async ({ repository }: Parameters<GitHubCommitClient['listCommits']>[0]) => Array.from({ length: 100 }, (_, index) => commit({
				sha: `${repository}-${index}`,
				url: `https://github.com/acme/${repository}/commit/${index}`,
			}))),
		};
		const result = await collectCommitActivities({
			context: project(['api', 'web', 'worker'].map((name) => ({ id: name, owner: 'acme', name }))),
			window,
			getClient: vi.fn(async () => client),
		});

		expect(result.commits).toHaveLength(200);
		expect(new Set(result.commits.map((item) => item.repository))).toEqual(new Set(['api', 'web', 'worker']));
		expect(result.truncated).toBe(true);
		expect(result.warnings.every((warning) => warning.reason === 'truncated')).toBe(true);
	});
});
