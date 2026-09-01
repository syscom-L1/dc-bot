import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type {
  GitHubAdapter,
  GitHubInstallationChoice,
  GitHubRepositoryChoice,
  GitHubSetupAdapter,
} from '../domain/adapters.js';
import type { ProgressUpdateAction, ProjectContext, WorkItem } from '../domain/models.js';
import { enrichGitHubSignals } from './enrich-signals.js';

const fieldValueSchema = z.object({
  __typename: z.string(),
  text: z.string().optional(),
  date: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  field: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
}).passthrough();

const projectContentSchema = z.object({
  __typename: z.enum(['Issue', 'PullRequest']),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  updatedAt: z.string(),
  merged: z.boolean().optional(),
  reviewDecision: z.string().nullable().optional(),
  repository: z.object({ nameWithOwner: z.string() }),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
});

const projectItemsResponseSchema = z.object({
  node: z.object({
    items: z.object({
      nodes: z.array(z.object({
        id: z.string(),
        content: projectContentSchema.nullable(),
        fieldValues: z.object({ nodes: z.array(fieldValueSchema) }),
      })),
    }),
  }).nullable(),
});

const projectFieldsResponseSchema = z.object({
  node: z.object({
    fields: z.object({
      nodes: z.array(z.object({
        __typename: z.string(),
        id: z.string(),
        name: z.string(),
        options: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      })),
    }),
  }).nullable(),
});

const projectItemsQuery = `
  query TeamAssistantProjectItems($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100) {
          nodes {
            id
            content {
              __typename
              ... on Issue {
                id number title url state updatedAt
                repository { nameWithOwner }
                assignees(first: 20) { nodes { login } }
              }
              ... on PullRequest {
                id number title url state updatedAt merged reviewDecision
                repository { nameWithOwner }
                assignees(first: 20) { nodes { login } }
              }
            }
            fieldValues(first: 50) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { id name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { id name } }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { id name } }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  field { ... on ProjectV2FieldCommon { id name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const projectFieldsQuery = `
  query TeamAssistantProjectFields($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2Field { id name }
            ... on ProjectV2IterationField { id name }
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
        }
      }
    }
  }
`;

function parseNameWithOwner(nameWithOwner: string): { owner: string; repository: string } {
  const [owner, repository] = nameWithOwner.split('/');
  if (!owner || !repository) throw new Error(`Invalid GitHub repository name: ${nameWithOwner}`);
  return { owner, repository };
}

function dateValue(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T15:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readMappedValue(
  values: z.infer<typeof fieldValueSchema>[],
  fieldName: string,
): string | undefined {
  const value = values.find((candidate) => candidate.field?.name === fieldName);
  return value?.name ?? value?.date ?? value?.title ?? value?.text;
}

export class OctokitGitHubAdapter implements GitHubAdapter, GitHubSetupAdapter {
  private readonly app: App;

  public constructor(options: { appId: string; privateKey: string }) {
    this.app = new App({ appId: options.appId, privateKey: options.privateKey });
  }

  private async installationOctokit(installationId: string) {
    const parsed = Number(installationId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid GitHub App installation ID: ${installationId}`);
    }
    const authentication = z.object({ token: z.string() }).parse(
      await this.app.octokit.auth({ type: 'installation', installationId: parsed }),
    );
    return new Octokit({ auth: authentication.token });
  }

  public async listInstallations(): Promise<GitHubInstallationChoice[]> {
    const { data: installations } = await this.app.octokit.request('GET /app/installations', {
      per_page: 100,
    });
    return installations.map((installation): GitHubInstallationChoice => ({
      id: String(installation.id),
      accountLogin: installation.account?.login ?? `installation-${installation.id}`,
      accountType: installation.account?.type === 'Organization' ? 'Organization' : 'User',
      repositorySelection: installation.repository_selection === 'all' ? 'all' : 'selected',
    })).sort((left, right) => left.accountLogin.localeCompare(right.accountLogin));
  }

  public async listInstallationRepositories(installationId: string): Promise<GitHubRepositoryChoice[]> {
    const octokit = await this.installationOctokit(installationId);
    const repositories = await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    return repositories.map((repository) => ({
      id: String(repository.id),
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
    })).sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  public async listWorkItems(context: ProjectContext): Promise<WorkItem[]> {
    const octokit = await this.installationOctokit(context.githubInstallationId);
    if (context.githubProjectId) {
      const response = projectItemsResponseSchema.parse(
        await octokit.graphql(projectItemsQuery, { projectId: context.githubProjectId }),
      );
      if (!response.node) throw new Error(`GitHub Project not found: ${context.githubProjectId}`);
      const workItems = response.node.items.nodes.flatMap((item): WorkItem[] => {
        if (!item.content) return [];
        const repository = parseNameWithOwner(item.content.repository.nameWithOwner);
        const fields = item.fieldValues.nodes;
        const mapping = context.config.githubProjectFields;
        const status = readMappedValue(fields, mapping.status);
        const priority = readMappedValue(fields, mapping.priority);
        const startDate = dateValue(readMappedValue(fields, mapping.startDate));
        const targetDate = dateValue(readMappedValue(fields, mapping.targetDate));
        const iteration = readMappedValue(fields, mapping.iteration);
        const workItem: WorkItem = {
          providerItemId: item.content.id,
          projectItemId: item.id,
          type: item.content.__typename === 'Issue' ? 'issue' : 'pull_request',
          owner: repository.owner,
          repository: repository.repository,
          number: item.content.number,
          title: item.content.title,
          url: item.content.url,
          state: item.content.merged ? 'merged' : item.content.state.toLowerCase() === 'open' ? 'open' : 'closed',
          assignees: item.content.assignees.nodes.map(({ login }) => login),
          updatedAt: new Date(item.content.updatedAt),
        };
        if (status) workItem.status = status;
        if (priority) workItem.priority = priority;
        if (startDate) workItem.startDate = startDate;
        if (targetDate) workItem.targetDate = targetDate;
        if (iteration) workItem.iteration = iteration;
        if (item.content.__typename === 'PullRequest') {
          workItem.reviewState = item.content.reviewDecision === 'APPROVED'
            ? 'approved'
            : item.content.reviewDecision === 'CHANGES_REQUESTED'
              ? 'changes_requested'
              : 'pending';
        }
        return [workItem];
      });
      return enrichGitHubSignals(octokit, workItems);
    }

    const workItems: WorkItem[] = [];
    const repositoriesByInstallation = new Map<string, typeof context.repositories>();
    for (const repository of context.repositories) {
      const installationId = repository.githubInstallationId ?? context.githubInstallationId;
      const repositories = repositoriesByInstallation.get(installationId) ?? [];
      repositories.push(repository);
      repositoriesByInstallation.set(installationId, repositories);
    }
    for (const [installationId, repositories] of repositoriesByInstallation) {
      const repositoryOctokit = installationId === context.githubInstallationId
        ? octokit
        : await this.installationOctokit(installationId);
      const installationItems: WorkItem[] = [];
      for (const repository of repositories) {
        const issues = await repositoryOctokit.paginate(repositoryOctokit.rest.issues.listForRepo, {
          owner: repository.owner,
          repo: repository.name,
          state: 'all',
          per_page: 100,
        });
        for (const issue of issues) {
          if (issue.pull_request) continue;
          installationItems.push({
            providerItemId: issue.node_id,
            type: 'issue',
            owner: repository.owner,
            repository: repository.name,
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            state: issue.state === 'open' ? 'open' : 'closed',
            assignees: issue.assignees?.map(({ login }) => login)
              .filter((login): login is string => Boolean(login)) ?? [],
            updatedAt: new Date(issue.updated_at),
          });
        }
        const pulls = await repositoryOctokit.paginate(repositoryOctokit.rest.pulls.list, {
          owner: repository.owner,
          repo: repository.name,
          state: 'all',
          per_page: 100,
        });
        for (const pull of pulls) {
          installationItems.push({
            providerItemId: pull.node_id,
            type: 'pull_request',
            owner: repository.owner,
            repository: repository.name,
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
            state: pull.merged_at ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
            assignees: pull.assignees?.map(({ login }) => login)
              .filter((login): login is string => Boolean(login)) ?? [],
            updatedAt: new Date(pull.updated_at),
            reviewState: 'pending',
          });
        }
      }
      workItems.push(...await enrichGitHubSignals(repositoryOctokit, installationItems));
    }
    return workItems;
  }

  public async applyProgressUpdate(action: ProgressUpdateAction): Promise<{
    commentUrl: string;
    projectStatusUpdated: boolean;
  }> {
    const octokit = await this.installationOctokit(action.installationId);
    const marker = `<!-- dcbot-proposal:${action.proposalId} -->`;
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: action.owner,
      repo: action.repository,
      issue_number: action.issueNumber,
      per_page: 100,
    });
    const existing = comments.find((comment) => comment.body?.includes(marker));
    let commentUrl = existing?.html_url;
    if (!commentUrl) {
      const response = await octokit.rest.issues.createComment({
        owner: action.owner,
        repo: action.repository,
        issue_number: action.issueNumber,
        body: `${marker}\n**Discord progress update**\n\nStatus: ${action.status}\n\n${action.progress}`,
      });
      commentUrl = response.data.html_url;
    }

    let projectStatusUpdated = false;
    if (action.projectId && action.projectItemId) {
      const fieldsResponse = projectFieldsResponseSchema.parse(
        await octokit.graphql(projectFieldsQuery, { projectId: action.projectId }),
      );
      if (!fieldsResponse.node) throw new Error(`GitHub Project not found: ${action.projectId}`);
      const statusField = fieldsResponse.node.fields.nodes.find(
        (field) => field.name === action.fieldMapping.status && field.options,
      );
      if (!statusField?.options) {
        throw new Error(`Mapped GitHub Project status field does not exist: ${action.fieldMapping.status}`);
      }
      const statusOption = statusField.options.find((option) => option.name === action.status);
      if (!statusOption) {
        throw new Error(`GitHub Project status option does not exist: ${action.status}`);
      }
      await octokit.graphql(
        `mutation TeamAssistantUpdateStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId,
            itemId: $itemId,
            fieldId: $fieldId,
            value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`,
        {
          projectId: action.projectId,
          itemId: action.projectItemId,
          fieldId: statusField.id,
          optionId: statusOption.id,
        },
      );
      projectStatusUpdated = true;
    }
    return { commentUrl, projectStatusUpdated };
  }

  public async checkConnection(installationId?: string): Promise<void> {
    if (installationId) {
      const octokit = await this.installationOctokit(installationId);
      await octokit.request('GET /installation/repositories', { per_page: 1 });
      return;
    }
    await this.app.octokit.request('GET /app');
  }
}
