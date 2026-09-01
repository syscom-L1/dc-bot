import {
  Prisma,
  PrismaClient,
  ProposalStatus,
  ProposalType,
  type ReminderResponseStatus,
  type ReminderType,
  type WebhookDeliveryStatus,
} from '@prisma/client';
import type { ProjectBindingConfig, ProjectContext } from '../domain/models.js';
import { projectBindingConfigSchema } from '../domain/models.js';
import type {
  AuditStore,
  DailyReportStore,
  DailyReportSessionRecord,
  DatabaseHealth,
  PersonRecord,
  PersonStore,
  ProjectBindingStore,
  ProposalRecord,
  ProposalStore,
  ReminderRecord,
  ReminderStore,
  WebhookDeliveryStore,
} from './contracts.js';

function json(value: object): Prisma.InputJsonValue {
  return value;
}

function projectConfigDefaults(): ProjectBindingConfig {
  return projectBindingConfigSchema.parse({});
}

const bindingInclude = {
  repositories: { where: { enabled: true }, orderBy: { name: 'asc' as const } },
} satisfies Prisma.ProjectBindingInclude;

type BindingWithRepositories = Prisma.ProjectBindingGetPayload<{ include: typeof bindingInclude }>;

function toProjectContext(binding: BindingWithRepositories): ProjectContext {
  const context: ProjectContext = {
    bindingId: binding.id,
    name: binding.name,
    discordGuildId: binding.discordGuildId,
    discordChannelId: binding.discordChannelId,
    githubOrganization: binding.githubOrganization,
    githubInstallationId: binding.githubInstallationId,
    repositories: binding.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      githubInstallationId: repository.githubInstallationId ?? binding.githubInstallationId,
    })),
    config: projectBindingConfigSchema.parse(binding.configJson),
  };
  if (binding.summaryChannelId) context.summaryChannelId = binding.summaryChannelId;
  if (binding.leaveChannelId) context.leaveChannelId = binding.leaveChannelId;
  if (binding.githubProjectId) context.githubProjectId = binding.githubProjectId;
  return context;
}

function toPersonRecord(person: {
  id: string;
  displayName: string;
  discordUserId: string;
  githubLogin: string;
  timezone: string;
  enabled: boolean;
}): PersonRecord {
  return person;
}

function toDailyReportSessionRecord(session: {
  id: string;
  projectBindingId: string;
  reportDate: string;
  status: "OPENING" | "OPEN" | "SUMMARIZED";
  discordChannelId: string;
  reminderMessageId: string | null;
  discordThreadId: string | null;
  expectedDiscordUserIds: string[];
  responseSnapshot: Prisma.JsonValue | null;
  summarySnapshot: Prisma.JsonValue | null;
  closesAt: Date;
}): DailyReportSessionRecord {
  return session;
}

export class PrismaStore
  implements
    WebhookDeliveryStore,
    PersonStore,
    ProjectBindingStore,
    ReminderStore,
    ProposalStore,
    AuditStore,
    DailyReportStore,
    DatabaseHealth
{
  public readonly client: PrismaClient;

  public constructor(client?: PrismaClient) {
    this.client = client ?? new PrismaClient();
  }

  public async checkConnection(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  public async close(): Promise<void> {
    await this.client.$disconnect();
  }

  public async tryCreate(input: {
    provider: string;
    deliveryId: string;
    eventType: string;
    payloadHash: string;
  }): Promise<boolean> {
    try {
      await this.client.webhookDelivery.create({ data: input });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  public async updateStatus(
    provider: string,
    deliveryId: string,
    status: WebhookDeliveryStatus,
    errorMessage?: string,
  ): Promise<void> {
    await this.client.webhookDelivery.update({
      where: { provider_deliveryId: { provider, deliveryId } },
      data: {
        status,
        errorMessage: errorMessage ?? null,
        ...(status === 'PROCESSED' ? { processedAt: new Date() } : {}),
        ...(status === 'FAILED' ? { retryCount: { increment: 1 } } : {}),
      },
    });
  }

  public async link(input: {
    displayName: string;
    discordUserId: string;
    githubLogin: string;
    timezone: string;
  }): Promise<PersonRecord> {
    const person = await this.client.person.upsert({
      where: { discordUserId: input.discordUserId },
      create: input,
      update: {
        displayName: input.displayName,
        githubLogin: input.githubLogin,
        timezone: input.timezone,
        enabled: true,
      },
    });
    return toPersonRecord(person);
  }

  public async findByDiscordUserId(discordUserId: string): Promise<PersonRecord | null> {
    const person = await this.client.person.findUnique({ where: { discordUserId } });
    return person ? toPersonRecord(person) : null;
  }

  public async findByGithubLogin(githubLogin: string): Promise<PersonRecord | null> {
    const person = await this.client.person.findFirst({
      where: { githubLogin: { equals: githubLogin, mode: 'insensitive' }, enabled: true },
    });
    return person ? toPersonRecord(person) : null;
  }

  public async listEnabled(): Promise<PersonRecord[]> {
    const people = await this.client.person.findMany({
      where: { enabled: true },
      orderBy: { displayName: 'asc' },
    });
    return people.map(toPersonRecord);
  }

  public async bindProject(input: {
    name: string;
    discordGuildId: string;
    discordChannelId: string;
    githubOrganization: string;
    githubProjectId?: string;
    githubInstallationId: string;
  }): Promise<ProjectContext> {
    const binding = await this.client.projectBinding.upsert({
      where: {
        discordGuildId_discordChannelId: {
          discordGuildId: input.discordGuildId,
          discordChannelId: input.discordChannelId,
        },
      },
      create: {
        ...input,
        githubProjectId: input.githubProjectId ?? null,
        configJson: json(projectConfigDefaults()),
      },
      update: {
        name: input.name,
        githubOrganization: input.githubOrganization,
        githubProjectId: input.githubProjectId ?? null,
        githubInstallationId: input.githubInstallationId,
        enabled: true,
      },
      include: bindingInclude,
    });
    return toProjectContext(binding);
  }

  public async bindRepository(input: {
    projectBindingId: string;
    owner: string;
    name: string;
    githubRepositoryId?: string;
    githubInstallationId?: string;
  }): Promise<void> {
    await this.client.repositoryBinding.upsert({
      where: { owner_name: { owner: input.owner, name: input.name } },
      create: {
        projectBindingId: input.projectBindingId,
        owner: input.owner,
        name: input.name,
        githubRepositoryId: input.githubRepositoryId ?? null,
        githubInstallationId: input.githubInstallationId ?? null,
      },
      update: {
        projectBindingId: input.projectBindingId,
        githubRepositoryId: input.githubRepositoryId ?? null,
        githubInstallationId: input.githubInstallationId ?? null,
        enabled: true,
      },
    });
  }

  public async setSummaryChannel(projectBindingId: string, channelId: string): Promise<void> {
    await this.client.projectBinding.update({
      where: { id: projectBindingId },
      data: { summaryChannelId: channelId },
    });
  }

  public async setLeaveChannel(projectBindingId: string, channelId: string): Promise<void> {
    await this.client.projectBinding.update({
      where: { id: projectBindingId },
      data: { leaveChannelId: channelId },
    });
  }

  public async findByLeaveChannel(guildId: string, channelId: string): Promise<ProjectContext | null> {
    const binding = await this.client.projectBinding.findFirst({
      where: { discordGuildId: guildId, leaveChannelId: channelId, enabled: true },
      include: bindingInclude,
    });
    return binding ? toProjectContext(binding) : null;
  }

  public async findByDiscordChannel(guildId: string, channelId: string): Promise<ProjectContext | null> {
    const binding = await this.client.projectBinding.findUnique({
      where: { discordGuildId_discordChannelId: { discordGuildId: guildId, discordChannelId: channelId } },
      include: bindingInclude,
    });
    return binding ? toProjectContext(binding) : null;
  }

  public async findProjectById(id: string): Promise<ProjectContext | null> {
    const binding = await this.client.projectBinding.findUnique({ where: { id }, include: bindingInclude });
    return binding ? toProjectContext(binding) : null;
  }

  public async listActive(): Promise<ProjectContext[]> {
    const bindings = await this.client.projectBinding.findMany({
      where: { enabled: true },
      include: bindingInclude,
      orderBy: { name: 'asc' },
    });
    return bindings.map(toProjectContext);
  }

  public async listByGuild(guildId: string): Promise<ProjectContext[]> {
    const bindings = await this.client.projectBinding.findMany({
      where: { discordGuildId: guildId, enabled: true },
      include: bindingInclude,
      orderBy: { name: 'asc' },
    });
    return bindings.map(toProjectContext);
  }

  public async getOrCreateDailyReport(input: {
    projectBindingId: string;
    reportDate: string;
    discordChannelId: string;
    expectedDiscordUserIds: string[];
    closesAt: Date;
  }): Promise<DailyReportSessionRecord> {
    const session = await this.client.dailyReportSession.upsert({
      where: {
        projectBindingId_reportDate: {
          projectBindingId: input.projectBindingId,
          reportDate: input.reportDate,
        },
      },
      create: input,
      update: {
        expectedDiscordUserIds: input.expectedDiscordUserIds,
        closesAt: input.closesAt,
      },
    });
    return toDailyReportSessionRecord(session);
  }

  public async markDailyReportOpened(
    id: string,
    reminderMessageId: string,
    discordThreadId: string,
    openedAt: Date,
  ): Promise<void> {
    await this.client.dailyReportSession.update({
      where: { id },
      data: { status: 'OPEN', reminderMessageId, discordThreadId, openedAt },
    });
  }

  public async listOpenDailyReportsThrough(reportDate: string): Promise<DailyReportSessionRecord[]> {
    const sessions = await this.client.dailyReportSession.findMany({
      where: { status: 'OPEN', reportDate: { lte: reportDate } },
      orderBy: { reportDate: 'asc' },
    });
    return sessions.map(toDailyReportSessionRecord);
  }

  public async markDailyReportSummarized(input: {
    id: string;
    responses: object[];
    summary: object;
    summaryMessageIds: string[];
    summarizedAt: Date;
  }): Promise<void> {
    await this.client.dailyReportSession.update({
      where: { id: input.id },
      data: {
        status: 'SUMMARIZED',
        responseSnapshot: json(input.responses),
        summarySnapshot: json(input.summary),
        summaryMessageIds: input.summaryMessageIds,
        summarizedAt: input.summarizedAt,
      },
    });
  }

  public async upsertPending(input: {
    personId: string;
    providerItemId: string;
    reminderType: ReminderType;
    metadata: object;
    sentAt: Date;
  }): Promise<ReminderRecord> {
    const reminder = await this.client.reminderState.upsert({
      where: {
        personId_providerItemId_reminderType: {
          personId: input.personId,
          providerItemId: input.providerItemId,
          reminderType: input.reminderType,
        },
      },
      create: {
        personId: input.personId,
        providerItemId: input.providerItemId,
        reminderType: input.reminderType,
        metadataJson: json(input.metadata),
        lastSentAt: input.sentAt,
      },
      update: {
        metadataJson: json(input.metadata),
        lastSentAt: input.sentAt,
      },
    });
    return {
      id: reminder.id,
      personId: reminder.personId,
      providerItemId: reminder.providerItemId,
      reminderType: reminder.reminderType,
      lastSentAt: reminder.lastSentAt,
      snoozedUntil: reminder.snoozedUntil,
      responseStatus: reminder.responseStatus,
      metadata: reminder.metadataJson,
    };
  }

  public async findReminderById(id: string): Promise<ReminderRecord | null> {
    const reminder = await this.client.reminderState.findUnique({ where: { id } });
    return reminder
      ? {
          id: reminder.id,
          personId: reminder.personId,
          providerItemId: reminder.providerItemId,
          reminderType: reminder.reminderType,
          lastSentAt: reminder.lastSentAt,
          snoozedUntil: reminder.snoozedUntil,
          responseStatus: reminder.responseStatus,
          metadata: reminder.metadataJson,
        }
      : null;
  }

  public async setResponse(
    id: string,
    status: ReminderResponseStatus,
    snoozedUntil?: Date,
  ): Promise<void> {
    await this.client.reminderState.update({
      where: { id },
      data: { responseStatus: status, snoozedUntil: snoozedUntil ?? null },
    });
  }

  public async hasConfirmedLeave(personId: string, at: Date): Promise<boolean> {
    return (await this.client.leaveNotice.count({
      where: { personId, status: 'CONFIRMED', startAt: { lte: at }, endAt: { gt: at } },
    })) > 0;
  }

  public async createProgressUpdate(input: {
    id: string;
    requestedBy: string;
    sourceReference: object;
    input: object;
    action: import('../domain/models.js').ProgressUpdateAction;
  }): Promise<ProposalRecord> {
    const proposal = await this.client.aiProposal.create({
      data: {
        id: input.id,
        proposalType: ProposalType.PROGRESS_UPDATE,
        requestedBy: input.requestedBy,
        sourceType: 'discord_reminder',
        sourceReference: json(input.sourceReference),
        inputJson: json(input.input),
        proposedActionJson: json(input.action),
      },
    });
    return {
      id: proposal.id,
      status: proposal.status,
      requestedBy: proposal.requestedBy,
      proposedAction: proposal.proposedActionJson,
    };
  }

  public async findProposalById(id: string): Promise<ProposalRecord | null> {
    const proposal = await this.client.aiProposal.findUnique({ where: { id } });
    return proposal
      ? {
          id: proposal.id,
          status: proposal.status,
          requestedBy: proposal.requestedBy,
          proposedAction: proposal.proposedActionJson,
        }
      : null;
  }

  public async claimForExecution(id: string, confirmedBy: string): Promise<ProposalRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const claimed = await transaction.aiProposal.updateMany({
        where: { id, status: ProposalStatus.PROPOSED, requestedBy: confirmedBy },
        data: { status: ProposalStatus.CONFIRMED, confirmedBy, confirmedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const proposal = await transaction.aiProposal.findUniqueOrThrow({ where: { id } });
      return {
        id: proposal.id,
        status: proposal.status,
        requestedBy: proposal.requestedBy,
        proposedAction: proposal.proposedActionJson,
      };
    });
  }

  public async markExecuted(id: string): Promise<void> {
    await this.client.aiProposal.update({
      where: { id },
      data: { status: ProposalStatus.EXECUTED, executedAt: new Date(), errorMessage: null },
    });
  }

  public async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.client.aiProposal.update({
      where: { id },
      data: { status: ProposalStatus.FAILED, errorMessage: errorMessage.slice(0, 2_000) },
    });
  }

  public async reject(id: string, actorId: string): Promise<boolean> {
    const result = await this.client.aiProposal.updateMany({
      where: { id, status: ProposalStatus.PROPOSED, requestedBy: actorId },
      data: { status: ProposalStatus.REJECTED, confirmedBy: actorId, confirmedAt: new Date() },
    });
    return result.count === 1;
  }

  public async append(input: {
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    before?: object;
    after?: object;
    requestId: string;
  }): Promise<void> {
    await this.client.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ...(input.before ? { beforeJson: json(input.before) } : {}),
        ...(input.after ? { afterJson: json(input.after) } : {}),
        requestId: input.requestId,
      },
    });
  }
}
