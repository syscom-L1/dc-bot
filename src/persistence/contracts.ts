import type {
  ProposalStatus,
  ReminderResponseStatus,
  ReminderType,
  WebhookDeliveryStatus,
} from '@prisma/client';
import type { ProgressUpdateAction, ProjectContext } from '../domain/models.js';

export interface WebhookDeliveryStore {
  tryCreate(input: {
    provider: string;
    deliveryId: string;
    eventType: string;
    payloadHash: string;
  }): Promise<boolean>;
  updateStatus(
    provider: string,
    deliveryId: string,
    status: WebhookDeliveryStatus,
    errorMessage?: string,
  ): Promise<void>;
}

export interface PersonRecord {
  id: string;
  displayName: string;
  discordUserId: string;
  githubLogin: string;
  timezone: string;
  enabled: boolean;
}

export interface PersonStore {
  link(input: {
    displayName: string;
    discordUserId: string;
    githubLogin: string;
    timezone: string;
  }): Promise<PersonRecord>;
  findByDiscordUserId(discordUserId: string): Promise<PersonRecord | null>;
  findByGithubLogin(githubLogin: string): Promise<PersonRecord | null>;
  listEnabled(): Promise<PersonRecord[]>;
}

export interface ProjectBindingStore {
  bindProject(input: {
    name: string;
    discordGuildId: string;
    discordChannelId: string;
    githubOrganization: string;
    githubProjectId?: string;
    githubInstallationId: string;
  }): Promise<ProjectContext>;
  bindRepository(input: {
    projectBindingId: string;
    owner: string;
    name: string;
    githubRepositoryId?: string;
    githubInstallationId?: string;
  }): Promise<void>;
  setSummaryChannel(projectBindingId: string, channelId: string): Promise<void>;
  setLeaveChannel(projectBindingId: string, channelId: string): Promise<void>;
  findByLeaveChannel(guildId: string, channelId: string): Promise<ProjectContext | null>;
  findByDiscordChannel(guildId: string, channelId: string): Promise<ProjectContext | null>;
  findProjectById(id: string): Promise<ProjectContext | null>;
  listActive(): Promise<ProjectContext[]>;
  listByGuild(guildId: string): Promise<ProjectContext[]>;
}

export interface DailyReportSessionRecord {
  id: string;
  projectBindingId: string;
  reportDate: string;
  status: "OPENING" | "OPEN" | "SUMMARIZED";
  discordChannelId: string;
  reminderMessageId: string | null;
  discordThreadId: string | null;
  expectedDiscordUserIds: string[];
  responseSnapshot: unknown;
  summarySnapshot: unknown;
  closesAt: Date;
}

export interface DailyReportStore {
  getOrCreateDailyReport(input: {
    projectBindingId: string;
    reportDate: string;
    discordChannelId: string;
    expectedDiscordUserIds: string[];
    closesAt: Date;
  }): Promise<DailyReportSessionRecord>;
  markDailyReportOpened(id: string, reminderMessageId: string, discordThreadId: string, openedAt: Date): Promise<void>;
  listOpenDailyReportsThrough(reportDate: string): Promise<DailyReportSessionRecord[]>;
  markDailyReportSummarized(input: {
    id: string;
    responses: object[];
    summary: object;
    summaryMessageIds: string[];
    summarizedAt: Date;
  }): Promise<void>;
}

export interface ReminderRecord {
  id: string;
  personId: string;
  providerItemId: string;
  reminderType: ReminderType;
  lastSentAt: Date | null;
  snoozedUntil: Date | null;
  responseStatus: ReminderResponseStatus;
  metadata: unknown;
}

export interface ReminderStore {
  upsertPending(input: {
    personId: string;
    providerItemId: string;
    reminderType: ReminderType;
    metadata: object;
    sentAt: Date;
  }): Promise<ReminderRecord>;
  findReminderById(id: string): Promise<ReminderRecord | null>;
  setResponse(id: string, status: ReminderResponseStatus, snoozedUntil?: Date): Promise<void>;
  hasConfirmedLeave(personId: string, at: Date): Promise<boolean>;
}

export interface ProposalRecord {
  id: string;
  status: ProposalStatus;
  requestedBy: string;
  proposedAction: unknown;
}

export interface ProposalStore {
  createProgressUpdate(input: {
    id: string;
    requestedBy: string;
    sourceReference: object;
    input: object;
    action: ProgressUpdateAction;
  }): Promise<ProposalRecord>;
  findProposalById(id: string): Promise<ProposalRecord | null>;
  claimForExecution(id: string, confirmedBy: string): Promise<ProposalRecord | null>;
  markExecuted(id: string): Promise<void>;
  markFailed(id: string, errorMessage: string): Promise<void>;
  reject(id: string, actorId: string): Promise<boolean>;
}

export interface AuditStore {
  append(input: {
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    before?: object;
    after?: object;
    requestId: string;
  }): Promise<void>;
}

export interface DatabaseHealth {
  checkConnection(): Promise<void>;
  close(): Promise<void>;
}
