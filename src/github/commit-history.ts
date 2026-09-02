import type {
	CommitActivity,
	CommitHistoryResult,
	CommitHistoryWarning,
	CommitHistoryWindow,
	ProjectContext,
} from '../domain/models.js';

const BRANCH_CONCURRENCY = 4;
const MAX_COMMITS_PER_BRANCH = 100;
const MAX_COMMITS_PER_REPOSITORY = 100;
const MAX_COMMITS_PER_PROJECT = 200;
const MAX_MESSAGE_LENGTH = 200;

export interface GitHubCommitRecord {
	sha: string;
	url: string;
	message: string;
	committedAt: string | null;
	parentCount: number;
	authorLogin: string | null;
	authorType: string | null;
	committerLogin: string | null;
	committerType: string | null;
}

export interface GitHubCommitClient {
	listBranches(owner: string, repository: string): Promise<string[]>;
	listCommits(input: {
		owner: string;
		repository: string;
		branch: string;
		window: CommitHistoryWindow;
		limit: number;
	}): Promise<GitHubCommitRecord[]>;
}

interface RepositoryCommitResult {
	commits: CommitActivity[];
	warnings: CommitHistoryWarning[];
	rateLimited: boolean;
}

function repositoryKey(owner: string, repository: string): string {
	return `${owner}/${repository}`;
}

function warningKey(warning: CommitHistoryWarning): string {
	return `${warning.repository}:${warning.reason}`;
}

function uniqueWarnings(warnings: CommitHistoryWarning[]): CommitHistoryWarning[] {
	const seen = new Set<string>();
	return warnings.filter((warning) => {
		const key = warningKey(warning);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isRateLimitError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const status = 'status' in error && typeof error.status === 'number' ? error.status : null;
	if (status === 429) return true;
	if (status !== 403) return false;
	return /rate.?limit/iu.test(error.message);
}

export function isEmptyRepositoryError(error: unknown): boolean {
	return error instanceof Error
		&& 'status' in error
		&& error.status === 409
		&& /repository is empty/iu.test(error.message);
}

function isBotCommit(commit: GitHubCommitRecord): boolean {
	const logins = [commit.authorLogin, commit.committerLogin].filter((login): login is string => Boolean(login));
	return commit.authorType === 'Bot'
		|| commit.committerType === 'Bot'
		|| logins.some((login) => login.toLowerCase().endsWith('[bot]'));
}

function firstMessageLine(message: string): string {
	return (message.split(/\r?\n/u)[0] ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

async function runWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	callback: (item: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			const item = items[index];
			if (typeof item === 'undefined') return;
			await callback(item);
		}
	};
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(Array.from({ length: workerCount }, async () => worker()));
}

async function collectRepositoryCommits(input: {
	client: GitHubCommitClient;
	owner: string;
	repository: string;
	window: CommitHistoryWindow;
}): Promise<RepositoryCommitResult> {
	const repository = repositoryKey(input.owner, input.repository);
	let branches: string[];
	try {
		branches = await input.client.listBranches(input.owner, input.repository);
	} catch (error) {
		return {
			commits: [],
			warnings: [{ repository, reason: isRateLimitError(error) ? 'rate_limited' : 'branch_list_failed' }],
			rateLimited: isRateLimitError(error),
		};
	}

	const activities = new Map<string, CommitActivity & { branchSet: Set<string> }>();
	const warnings: CommitHistoryWarning[] = [];
	let rateLimited = false;
	let branchLimitReached = false;
	await runWithConcurrency(branches, BRANCH_CONCURRENCY, async (branch) => {
		if (rateLimited) return;
		try {
			const commits = await input.client.listCommits({
				owner: input.owner,
				repository: input.repository,
				branch,
				window: input.window,
				limit: MAX_COMMITS_PER_BRANCH,
			});
			if (commits.length >= MAX_COMMITS_PER_BRANCH) branchLimitReached = true;
			for (const commit of commits) {
				if (commit.parentCount > 1 || isBotCommit(commit) || !commit.committedAt) continue;
				const message = firstMessageLine(commit.message);
				if (!message) continue;
				const committedAt = new Date(commit.committedAt);
				if (Number.isNaN(committedAt.getTime())) continue;
				const existing = activities.get(commit.sha);
				if (existing) {
					existing.branchSet.add(branch);
					continue;
				}
				activities.set(commit.sha, {
					owner: input.owner,
					repository: input.repository,
					sha: commit.sha,
					url: commit.url,
					message,
					committedAt,
					branches: [],
					branchSet: new Set([branch]),
				});
			}
		} catch (error) {
			if (isRateLimitError(error)) {
				rateLimited = true;
				warnings.push({ repository, reason: 'rate_limited' });
				return;
			}
			warnings.push({ repository, reason: 'branch_query_failed' });
		}
	});

	const sorted = [...activities.values()].sort((left, right) => right.committedAt.getTime() - left.committedAt.getTime());
	const truncated = branchLimitReached || sorted.length > MAX_COMMITS_PER_REPOSITORY;
	if (truncated) warnings.push({ repository, reason: 'truncated' });
	return {
		commits: sorted.slice(0, MAX_COMMITS_PER_REPOSITORY).map(({ branchSet, ...commit }) => ({
			...commit,
			branches: [...branchSet].sort(),
		})),
		warnings: uniqueWarnings(warnings),
		rateLimited,
	};
}

function selectBalancedCommits(commitsByRepository: CommitActivity[][]): {
	commits: CommitActivity[];
	truncatedRepositories: string[];
} {
	const selected: CommitActivity[] = [];
	const indexes = commitsByRepository.map(() => 0);
	while (selected.length < MAX_COMMITS_PER_PROJECT) {
		let added = false;
		for (let repositoryIndex = 0; repositoryIndex < commitsByRepository.length; repositoryIndex += 1) {
			if (selected.length >= MAX_COMMITS_PER_PROJECT) break;
			const commits = commitsByRepository[repositoryIndex] ?? [];
			const commitIndex = indexes[repositoryIndex] ?? 0;
			const commit = commits[commitIndex];
			if (!commit) continue;
			selected.push(commit);
			indexes[repositoryIndex] = commitIndex + 1;
			added = true;
		}
		if (!added) break;
	}
	const truncatedRepositories = commitsByRepository.flatMap((commits, index) => {
		const included = indexes[index] ?? 0;
		const first = commits[0];
		return commits.length > included && first ? [repositoryKey(first.owner, first.repository)] : [];
	});
	return {
		commits: selected.sort((left, right) => right.committedAt.getTime() - left.committedAt.getTime()),
		truncatedRepositories,
	};
}

export async function collectCommitActivities(input: {
	context: ProjectContext;
	window: CommitHistoryWindow;
	getClient: (installationId: string) => Promise<GitHubCommitClient>;
}): Promise<CommitHistoryResult> {
	const repositoriesByInstallation = new Map<string, typeof input.context.repositories>();
	for (const repository of input.context.repositories) {
		const installationId = repository.githubInstallationId ?? input.context.githubInstallationId;
		const repositories = repositoriesByInstallation.get(installationId) ?? [];
		repositories.push(repository);
		repositoriesByInstallation.set(installationId, repositories);
	}

	const commitsByRepository: CommitActivity[][] = [];
	const warnings: CommitHistoryWarning[] = [];
	for (const [installationId, repositories] of repositoriesByInstallation) {
		let client: GitHubCommitClient;
		try {
			client = await input.getClient(installationId);
		} catch (error) {
			const reason = isRateLimitError(error) ? 'rate_limited' : 'branch_list_failed';
			warnings.push(...repositories.map((repository) => ({
				repository: repositoryKey(repository.owner, repository.name),
				reason,
			}) satisfies CommitHistoryWarning));
			continue;
		}
		let installationRateLimited = false;
		for (const repository of repositories) {
			if (installationRateLimited) {
				warnings.push({ repository: repositoryKey(repository.owner, repository.name), reason: 'rate_limited' });
				continue;
			}
			const result = await collectRepositoryCommits({
				client,
				owner: repository.owner,
				repository: repository.name,
				window: input.window,
			});
			commitsByRepository.push(result.commits);
			warnings.push(...result.warnings);
			installationRateLimited = result.rateLimited;
		}
	}

	const balanced = selectBalancedCommits(commitsByRepository);
	warnings.push(...balanced.truncatedRepositories.map((repository) => ({ repository, reason: 'truncated' } as const)));
	const normalizedWarnings = uniqueWarnings(warnings);
	return {
		commits: balanced.commits,
		warnings: normalizedWarnings,
		truncated: normalizedWarnings.some((warning) => warning.reason === 'truncated'),
	};
}
