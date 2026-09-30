import { z } from 'zod';

export const projectFieldMappingSchema = z.object({
  status: z.string().default('Status'),
  priority: z.string().default('Priority'),
  startDate: z.string().default('Start Date'),
  targetDate: z.string().default('Target Date'),
  iteration: z.string().default('Iteration'),
});

export const projectBindingConfigSchema = z.object({
  githubProjectFields: projectFieldMappingSchema.default({}),
  statusOptions: z.object({
    backlog: z.string().default('Backlog'),
    ready: z.string().default('Ready'),
    inProgress: z.string().default('In Progress'),
    review: z.string().default('Review'),
    blocked: z.string().default('Blocked'),
    done: z.string().default('Done'),
  }).default({}),
  autoUpdateGithubStatus: z.boolean().default(false),
  dueSoonDays: z.number().int().positive().default(3),
  inactivityHours: z.number().int().positive().default(48),
});

export type ProjectBindingConfig = z.infer<typeof projectBindingConfigSchema>;

export interface ProjectContext {
  bindingId: string;
  name: string;
  discordGuildId: string;
  discordChannelId: string;
  summaryChannelId?: string;
  leaveChannelId?: string;
  githubOrganization: string;
  githubProjectId?: string;
  githubInstallationId: string;
  repositories: Array<{ id: string; owner: string; name: string; githubInstallationId?: string }>;
  config: ProjectBindingConfig;
}

export function repositoryInstallationId(
  project: ProjectContext,
  owner: string,
  repository: string,
): string {
  return project.repositories.find((item) => (
    item.owner.toLowerCase() === owner.toLowerCase()
    && item.name.toLowerCase() === repository.toLowerCase()
  ))?.githubInstallationId ?? project.githubInstallationId;
}

export interface WorkItem {
  providerItemId: string;
  projectItemId?: string;
  type: 'issue' | 'pull_request';
  owner: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  assignees: string[];
  status?: string;
  priority?: string;
  startDate?: Date;
  targetDate?: Date;
  iteration?: string;
  updatedAt: Date;
  reviewState?: 'approved' | 'changes_requested' | 'pending';
  workflowState?: 'success' | 'failure' | 'pending' | 'unknown';
}

export interface CommitActivity {
	owner: string;
	repository: string;
	sha: string;
	url: string;
	message: string;
	committedAt: Date;
	branches: string[];
}

export interface CommitHistoryWarning {
	repository: string;
	reason: 'branch_list_failed' | 'branch_query_failed' | 'rate_limited' | 'truncated';
}

export interface CommitHistoryResult {
	commits: CommitActivity[];
	warnings: CommitHistoryWarning[];
	truncated: boolean;
}

export interface CommitHistoryWindow {
	since: Date;
	until: Date;
}

export const progressUpdateActionSchema = z.object({
  proposalId: z.string().uuid(),
  installationId: z.string().min(1),
  owner: z.string().min(1),
  repository: z.string().min(1),
  issueNumber: z.number().int().positive(),
  status: z.enum(['In Progress', 'Blocked', 'Done']),
  progress: z.string().min(1).max(2_000),
  projectId: z.string().optional(),
  projectItemId: z.string().optional(),
  fieldMapping: projectFieldMappingSchema,
});

export type ProgressUpdateAction = z.infer<typeof progressUpdateActionSchema>;
