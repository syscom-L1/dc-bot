import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { Prisma, PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import { z } from 'zod';
import { ConflictError } from '../common/errors.js';
import { issueBody, type DiscordSourceMessage, type IssueDraft } from './issue-draft.js';

export const issueCreationActionSchema = z.object({
  proposalId: z.string().uuid(),
  bindingId: z.string().uuid(),
  installationId: z.string().min(1),
  discordGuildId: z.string().min(1),
  discordChannelId: z.string().min(1),
  discordThreadId: z.string().nullable(),
  sourceMessageId: z.string().min(1),
  owner: z.string().min(1),
  repository: z.string().min(1),
  projectId: z.string().optional(),
  targetDateFieldName: z.string().min(1),
  title: z.string().min(3).max(200),
  body: z.string().min(1).max(60_000),
  suggestedAssignee: z.string().max(100).nullable(),
  suggestedTargetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sources: z.array(z.object({ id: z.string(), url: z.string().url() })).min(1).max(50),
});

export type IssueCreationAction = z.infer<typeof issueCreationActionSchema>;

export interface IssueProposalRecord {
  id: string;
  status: ProposalStatus;
  requestedBy: string;
  action: unknown;
}

export interface IssueProposalStore {
  create(input: {
    proposalId: string;
    requestedBy: string;
    traceId: string;
    draft: IssueDraft;
    action: IssueCreationAction;
  }): Promise<void>;
  find(id: string): Promise<IssueProposalRecord | null>;
  updateDraft(id: string, requestedBy: string, title: string, body: string): Promise<IssueCreationAction>;
  claim(id: string, requestedBy: string): Promise<IssueProposalRecord | null>;
  complete(input: {
    proposalId: string;
    actorId: string;
    action: IssueCreationAction;
    issueNumber: number;
    issueUrl: string;
    requestId: string;
  }): Promise<void>;
  markFailed(id: string, message: string): Promise<void>;
  reject(id: string, actorId: string): Promise<boolean>;
}

function json(value: object): Prisma.InputJsonValue {
  return value;
}

export class PrismaIssueProposalStore implements IssueProposalStore {
  public constructor(private readonly client: PrismaClient) {}

  public async create(input: {
    proposalId: string;
    requestedBy: string;
    traceId: string;
    draft: IssueDraft;
    action: IssueCreationAction;
  }): Promise<void> {
    await this.client.aiProposal.create({
      data: {
        id: input.proposalId,
        proposalType: ProposalType.ISSUE_CREATION,
        requestedBy: input.requestedBy,
        sourceType: 'discord_message',
        sourceReference: json({
          sourceMessageId: input.action.sourceMessageId,
          sources: input.action.sources,
        }),
        inputJson: json({ traceId: input.traceId, draft: input.draft }),
        proposedActionJson: json(input.action),
        confidence: input.draft.confidence,
      },
    });
  }

  public async find(id: string): Promise<IssueProposalRecord | null> {
    const proposal = await this.client.aiProposal.findUnique({ where: { id } });
    return proposal
      ? { id: proposal.id, status: proposal.status, requestedBy: proposal.requestedBy, action: proposal.proposedActionJson }
      : null;
  }

  public async updateDraft(
    id: string,
    requestedBy: string,
    title: string,
    body: string,
  ): Promise<IssueCreationAction> {
    return this.client.$transaction(async (transaction) => {
      const proposal = await transaction.aiProposal.findFirst({
        where: { id, requestedBy, status: ProposalStatus.PROPOSED },
      });
      if (!proposal) throw new ConflictError('Issue proposal is no longer editable');
      const action = issueCreationActionSchema.parse(proposal.proposedActionJson);
      const updated = issueCreationActionSchema.parse({ ...action, title, body });
      await transaction.aiProposal.update({
        where: { id },
        data: { proposedActionJson: json(updated) },
      });
      return updated;
    });
  }

  public async claim(id: string, requestedBy: string): Promise<IssueProposalRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const result = await transaction.aiProposal.updateMany({
        where: { id, requestedBy, status: ProposalStatus.PROPOSED },
        data: { status: ProposalStatus.CONFIRMED, confirmedBy: requestedBy, confirmedAt: new Date() },
      });
      if (result.count !== 1) return null;
      const proposal = await transaction.aiProposal.findUniqueOrThrow({ where: { id } });
      return { id: proposal.id, status: proposal.status, requestedBy: proposal.requestedBy, action: proposal.proposedActionJson };
    });
  }

  public async complete(input: {
    proposalId: string;
    actorId: string;
    action: IssueCreationAction;
    issueNumber: number;
    issueUrl: string;
    requestId: string;
  }): Promise<void> {
    await this.client.$transaction([
      this.client.messageIssueLink.create({
        data: {
          projectBindingId: input.action.bindingId,
          discordGuildId: input.action.discordGuildId,
          discordChannelId: input.action.discordChannelId,
          discordMessageId: input.action.sourceMessageId,
          discordThreadId: input.action.discordThreadId,
          githubRepository: `${input.action.owner}/${input.action.repository}`,
          githubIssueNumber: input.issueNumber,
          createdBy: input.actorId,
        },
      }),
      this.client.auditLog.create({
        data: {
          actorType: 'discord_user',
          actorId: input.actorId,
          action: 'github.issue.create',
          resourceType: 'github_issue',
          resourceId: `${input.action.owner}/${input.action.repository}#${input.issueNumber}`,
          beforeJson: json({ proposalStatus: 'PROPOSED' }),
          afterJson: json({ issueUrl: input.issueUrl, title: input.action.title }),
          requestId: input.requestId,
        },
      }),
      this.client.aiProposal.update({
        where: { id: input.proposalId },
        data: { status: ProposalStatus.EXECUTED, executedAt: new Date(), errorMessage: null },
      }),
    ]);
  }

  public async markFailed(id: string, message: string): Promise<void> {
    await this.client.aiProposal.update({
      where: { id },
      data: { status: ProposalStatus.FAILED, errorMessage: message.slice(0, 2_000) },
    });
  }

  public async reject(id: string, actorId: string): Promise<boolean> {
    const result = await this.client.aiProposal.updateMany({
      where: { id, requestedBy: actorId, status: ProposalStatus.PROPOSED },
      data: { status: ProposalStatus.REJECTED, confirmedBy: actorId, confirmedAt: new Date() },
    });
    return result.count === 1;
  }
}

export interface GitHubIssueWriter {
  createIssue(action: IssueCreationAction): Promise<{ issueNumber: number; issueUrl: string }>;
}

const projectFieldsSchema = z.object({
  node: z.object({
    fields: z.object({
      nodes: z.array(z.object({ id: z.string(), name: z.string(), dataType: z.string().optional() })),
    }),
  }).nullable(),
});

export class OctokitIssueWriter implements GitHubIssueWriter {
  private readonly app: App;

  public constructor(options: { appId: string; privateKey: string }) {
    this.app = new App({ appId: options.appId, privateKey: options.privateKey });
  }

  private async octokit(installationId: string): Promise<Octokit> {
    const parsed = Number(installationId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Invalid GitHub installation ID');
    const auth = z.object({ token: z.string() }).parse(
      await this.app.octokit.auth({ type: 'installation', installationId: parsed }),
    );
    return new Octokit({ auth: auth.token });
  }

  public async createIssue(action: IssueCreationAction): Promise<{ issueNumber: number; issueUrl: string }> {
    const octokit = await this.octokit(action.installationId);
    let targetFieldId: string | undefined;
    if (action.projectId && action.suggestedTargetDate) {
      const fields = projectFieldsSchema.parse(await octokit.graphql(
        `query IssueCreationFields($projectId: ID!) {
          node(id: $projectId) { ... on ProjectV2 {
            fields(first: 100) { nodes { ... on ProjectV2Field { id name dataType } } }
          } }
        }`,
        { projectId: action.projectId },
      ));
      if (!fields.node) throw new Error(`GitHub Project not found: ${action.projectId}`);
      targetFieldId = fields.node.fields.nodes.find((field) => (
        field.name === action.targetDateFieldName && field.dataType === 'DATE'
      ))?.id;
      if (!targetFieldId) throw new Error(`Mapped GitHub Project date field does not exist: ${action.targetDateFieldName}`);
    }

    const created = await octokit.rest.issues.create({
      owner: action.owner,
      repo: action.repository,
      title: action.title,
      body: action.body,
      ...(action.suggestedAssignee ? { assignees: [action.suggestedAssignee] } : {}),
    });
    if (action.projectId) {
      const added = z.object({
        addProjectV2ItemById: z.object({ item: z.object({ id: z.string() }) }),
      }).parse(await octokit.graphql(
        `mutation AddCreatedIssue($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
        }`,
        { projectId: action.projectId, contentId: created.data.node_id },
      ));
      if (targetFieldId && action.suggestedTargetDate) {
        await octokit.graphql(
          `mutation SetCreatedIssueDate($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { date: $date }
            }) { projectV2Item { id } }
          }`,
          {
            projectId: action.projectId,
            itemId: added.addProjectV2ItemById.item.id,
            fieldId: targetFieldId,
            date: action.suggestedTargetDate,
          },
        );
      }
    }
    return { issueNumber: created.data.number, issueUrl: created.data.html_url };
  }
}

export class IssueCreationService {
  public constructor(
    private readonly proposals: IssueProposalStore,
    private readonly github: GitHubIssueWriter
  ) {}

  public async saveDraft(input: {
    proposalId: string;
    requestedBy: string;
    traceId: string;
    draft: IssueDraft;
    bindingId: string;
    installationId: string;
    discordGuildId: string;
    discordChannelId: string;
    discordThreadId: string | null;
    sourceMessageId: string;
    owner: string;
    repository: string;
    projectId?: string;
    targetDateFieldName: string;
    sources: DiscordSourceMessage[];
  }): Promise<IssueCreationAction> {
    const action = issueCreationActionSchema.parse({
      proposalId: input.proposalId,
      bindingId: input.bindingId,
      installationId: input.installationId,
      discordGuildId: input.discordGuildId,
      discordChannelId: input.discordChannelId,
      discordThreadId: input.discordThreadId,
      sourceMessageId: input.sourceMessageId,
      owner: input.owner,
      repository: input.repository,
      projectId: input.projectId,
      targetDateFieldName: input.targetDateFieldName,
      title: input.draft.title,
      body: issueBody(input.draft, input.sources, input.proposalId),
      suggestedAssignee: input.draft.suggestedAssignee,
      suggestedTargetDate: input.draft.suggestedTargetDate,
      sources: input.sources.map(({ id, url }) => ({ id, url })),
    });
    await this.proposals.create({
      proposalId: input.proposalId,
      requestedBy: input.requestedBy,
      traceId: input.traceId,
      draft: input.draft,
      action,
    });
    return action;
  }

  public async execute(id: string, actorId: string, requestId: string): Promise<string> {
    const claimed = await this.proposals.claim(id, actorId);
    if (!claimed) throw new ConflictError('Issue proposal is no longer pending or belongs to another user');
    const action = issueCreationActionSchema.parse(claimed.action);
    try {
      const result = await this.github.createIssue(action);
      await this.proposals.complete({
        proposalId: id,
        actorId,
        action,
        issueNumber: result.issueNumber,
        issueUrl: result.issueUrl,
        requestId,
      });
      return result.issueUrl;
    } catch (error) {
      await this.proposals.markFailed(id, error instanceof Error ? error.message : 'Unknown Issue creation error');
      throw error;
    }
  }

  public async edit(id: string, actorId: string, title: string, body: string): Promise<IssueCreationAction> {
    return this.proposals.updateDraft(id, actorId, title, body);
  }

  public async reject(id: string, actorId: string): Promise<void> {
    if (!await this.proposals.reject(id, actorId)) throw new ConflictError('Issue proposal is no longer pending');
  }
}

export function renderIssuePreview(action: IssueCreationAction): string {
  const bodyPreview = action.body.length > 900 ? `${action.body.slice(0, 900)}…` : action.body;
  return `建議建立 GitHub Issue：\n\nRepository：${action.owner}/${action.repository}\nTitle：${action.title}\nAssignee：${action.suggestedAssignee ?? '未指定'}\nTarget Date：${action.suggestedTargetDate ?? '未指定'}\n\n${bodyPreview}\n\n尚未寫入 GitHub。`;
}
