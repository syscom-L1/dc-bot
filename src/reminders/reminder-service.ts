import { randomUUID } from 'node:crypto';
import { ReminderResponseStatus, ReminderType } from '@prisma/client';
import { z } from 'zod';
import type { DiscordAdapter, GitHubAdapter } from '../domain/adapters.js';
import {
  progressUpdateActionSchema,
  repositoryInstallationId,
  type ProjectContext,
  type WorkItem,
} from '../domain/models.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors.js';
import { evaluateWorkItemRisks, type RiskRules } from '../github/rules.js';
import type {
  AuditStore,
  PersonStore,
  ProjectBindingStore,
  ProposalStore,
  ReminderStore,
} from '../persistence/contracts.js';

const reminderMetadataSchema = z.object({
  bindingId: z.string().uuid(),
  installationId: z.string().min(1),
  projectId: z.string().optional(),
  projectItemId: z.string().optional(),
  providerItemId: z.string().min(1),
  owner: z.string().min(1),
  repository: z.string().min(1),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  targetDate: z.string().optional(),
  fieldMapping: z.object({
    status: z.string(),
    priority: z.string(),
    startDate: z.string(),
    targetDate: z.string(),
    iteration: z.string(),
  }),
});

type ReminderMetadata = z.infer<typeof reminderMetadataSchema>;

function metadataFor(project: ProjectContext, item: WorkItem): ReminderMetadata {
  const metadata: ReminderMetadata = {
    bindingId: project.bindingId,
    installationId: repositoryInstallationId(project, item.owner, item.repository),
    providerItemId: item.providerItemId,
    owner: item.owner,
    repository: item.repository,
    issueNumber: item.number,
    title: item.title,
    url: item.url,
    fieldMapping: project.config.githubProjectFields,
  };
  if (project.githubProjectId) metadata.projectId = project.githubProjectId;
  if (item.projectItemId) metadata.projectItemId = item.projectItemId;
  if (item.targetDate) metadata.targetDate = item.targetDate.toISOString();
  return metadata;
}

export class ProgressReminderService {
  public constructor(
    private readonly bindings: ProjectBindingStore,
    private readonly people: PersonStore,
    private readonly reminders: ReminderStore,
    private readonly github: GitHubAdapter,
    private readonly discord: DiscordAdapter,
    private readonly rules: RiskRules,
  ) {}

  public async run(now = new Date()): Promise<number> {
    let sent = 0;
    for (const project of await this.bindings.listActive()) {
      const items = await this.github.listWorkItems(project);
      for (const item of items) {
        if (item.type !== 'issue') continue;
        const risks = evaluateWorkItemRisks(item, now, this.rules);
        const reminderType = risks.some((risk) => risk.type === 'overdue')
          ? ReminderType.OVERDUE
          : risks.some((risk) => risk.type === 'due_soon_inactive')
            ? ReminderType.DUE_SOON_INACTIVE
            : null;
        if (!reminderType) continue;
        const assignee = item.assignees[0];
        if (!assignee) continue;
        const person = await this.people.findByGithubLogin(assignee);
        if (!person || await this.reminders.hasConfirmedLeave(person.id, now)) continue;
        const reminder = await this.reminders.upsertPending({
          personId: person.id,
          providerItemId: item.providerItemId,
          reminderType,
          metadata: metadataFor(project, item),
          sentAt: now,
        });
        if (reminder.snoozedUntil && reminder.snoozedUntil > now) continue;

        const target = item.targetDate?.toISOString().slice(0, 10) ?? '未設定';
        const inactiveDays = Math.floor((now.getTime() - item.updatedAt.getTime()) / 86_400_000);
        await this.discord.sendDirectMessage(
          person.discordUserId,
          `目前有一件工作需要確認：\n\n[#${item.number} ${item.title}](<${item.url}>)\n期限：${target}\n最後 GitHub 活動：${inactiveDays} 天前\n\n目前狀況是？`,
          [
            { customId: `progress:still:${reminder.id}`, label: '還在進行', style: 'primary' },
            { customId: `progress:snooze:${reminder.id}`, label: '明天再問', style: 'secondary' },
          ],
        );
        sent += 1;
      }
    }
    return sent;
  }
}

export class ProgressProposalService {
  public constructor(
    private readonly people: PersonStore,
    private readonly reminders: ReminderStore,
    private readonly proposals: ProposalStore,
    private readonly github: GitHubAdapter,
    private readonly audit: AuditStore,
  ) {}

  public async proposeStillWorking(reminderId: string, discordUserId: string): Promise<{
    proposalId: string;
    preview: string;
  }> {
    const person = await this.people.findByDiscordUserId(discordUserId);
    if (!person) throw new ForbiddenError('Discord user is not linked to a GitHub user');
    const reminder = await this.reminders.findReminderById(reminderId);
    if (!reminder) throw new NotFoundError('Reminder not found');
    if (reminder.personId !== person.id) throw new ForbiddenError('This reminder belongs to another user');
    const metadata = reminderMetadataSchema.parse(reminder.metadata);
    const proposalId = randomUUID();
    const action = progressUpdateActionSchema.parse({
      proposalId,
      installationId: metadata.installationId,
      owner: metadata.owner,
      repository: metadata.repository,
      issueNumber: metadata.issueNumber,
      status: 'In Progress',
      progress: '目前仍在進行；由負責人於 Discord 確認。',
      projectId: metadata.projectId,
      projectItemId: metadata.projectItemId,
      fieldMapping: metadata.fieldMapping,
    });
    await this.proposals.createProgressUpdate({
      id: proposalId,
      requestedBy: discordUserId,
      sourceReference: { reminderId, providerItemId: metadata.providerItemId },
      input: { interaction: 'still_working' },
      action,
    });
    await this.reminders.setResponse(reminderId, ReminderResponseStatus.STILL_WORKING);
    return {
      proposalId,
      preview: `建議更新：\n\nIssue：[${metadata.owner}/${metadata.repository}#${metadata.issueNumber} ${metadata.title}](<${metadata.url}>)\n狀態：In Progress\n進度：目前仍在進行\n\n確認後才會寫入 GitHub。`,
    };
  }

  public async snooze(reminderId: string, discordUserId: string, now = new Date()): Promise<void> {
    const person = await this.people.findByDiscordUserId(discordUserId);
    const reminder = await this.reminders.findReminderById(reminderId);
    if (!person || !reminder || reminder.personId !== person.id) throw new ForbiddenError();
    await this.reminders.setResponse(
      reminderId,
      ReminderResponseStatus.SNOOZED,
      new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    );
  }

  public async execute(proposalId: string, discordUserId: string, requestId: string): Promise<string> {
    const person = await this.people.findByDiscordUserId(discordUserId);
    if (!person) throw new ForbiddenError('Discord user is not linked to GitHub');
    const proposal = await this.proposals.claimForExecution(proposalId, discordUserId);
    if (!proposal) throw new ConflictError('Proposal is no longer pending or belongs to another user');
    const action = progressUpdateActionSchema.parse(proposal.proposedAction);
    try {
      const result = await this.github.applyProgressUpdate(action);
      await this.audit.append({
        actorType: 'discord_user',
        actorId: discordUserId,
        action: 'github.issue.progress_update',
        resourceType: 'github_issue',
        resourceId: `${action.owner}/${action.repository}#${action.issueNumber}`,
        before: { proposalStatus: 'PROPOSED' },
        after: { ...result, status: action.status, progress: action.progress },
        requestId,
      });
      await this.proposals.markExecuted(proposalId);
      return result.commentUrl;
    } catch (error) {
      await this.proposals.markFailed(
        proposalId,
        error instanceof Error ? error.message : 'Unknown GitHub update error',
      );
      throw error;
    }
  }

  public async reject(proposalId: string, discordUserId: string): Promise<void> {
    if (!await this.proposals.reject(proposalId, discordUserId)) {
      throw new ConflictError('Proposal is no longer pending or belongs to another user');
    }
  }
}
