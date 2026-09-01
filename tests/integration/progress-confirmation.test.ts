import {
  ProposalStatus,
  ReminderResponseStatus,
  ReminderType,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { GitHubAdapter } from '../../src/domain/adapters.js';
import type { ProgressUpdateAction } from '../../src/domain/models.js';
import type {
  AuditStore,
  PersonRecord,
  PersonStore,
  ProposalRecord,
  ProposalStore,
  ReminderRecord,
  ReminderStore,
} from '../../src/persistence/contracts.js';
import { ProgressProposalService } from '../../src/reminders/reminder-service.js';

const person: PersonRecord = {
  id: '0f98df90-d0e2-4e5c-915a-1dd6e66468cf',
  displayName: 'Alice',
  discordUserId: 'discord-alice',
  githubLogin: 'alice',
  timezone: 'Asia/Taipei',
  enabled: true,
};

class FakePeople implements PersonStore {
  public async link(): Promise<PersonRecord> { return person; }
  public async findByDiscordUserId(id: string): Promise<PersonRecord | null> {
    return id === person.discordUserId ? person : null;
  }
  public async findByGithubLogin(login: string): Promise<PersonRecord | null> {
    return login === person.githubLogin ? person : null;
  }
  public async listEnabled(): Promise<PersonRecord[]> { return [person]; }
}

class FakeReminders implements ReminderStore {
  public readonly reminder: ReminderRecord = {
    id: 'ef2862f7-1d0a-4887-9490-431527dbf70e',
    personId: person.id,
    providerItemId: 'I_42',
    reminderType: ReminderType.DUE_SOON_INACTIVE,
    lastSentAt: new Date(),
    snoozedUntil: null,
    responseStatus: ReminderResponseStatus.PENDING,
    metadata: {
      bindingId: 'b0de74e6-9109-45d1-86e1-02d413c9024d',
      installationId: '123',
      projectId: 'PVT_1',
      projectItemId: 'PVTI_42',
      providerItemId: 'I_42',
      owner: 'acme',
      repository: 'api',
      issueNumber: 42,
      title: 'Vertical slice',
      url: 'https://github.com/acme/api/issues/42',
      fieldMapping: {
        status: 'Status',
        priority: 'Priority',
        startDate: 'Start Date',
        targetDate: 'Target Date',
        iteration: 'Iteration',
      },
    },
  };

  public async upsertPending(): Promise<ReminderRecord> { return this.reminder; }
  public async findReminderById(id: string): Promise<ReminderRecord | null> {
    return id === this.reminder.id ? this.reminder : null;
  }
  public async setResponse(_id: string, status: ReminderResponseStatus): Promise<void> {
    this.reminder.responseStatus = status;
  }
  public async hasConfirmedLeave(): Promise<boolean> { return false; }
}

class FakeProposals implements ProposalStore {
  public record: ProposalRecord | null = null;

  public async createProgressUpdate(input: {
    id: string;
    requestedBy: string;
    action: ProgressUpdateAction;
  }): Promise<ProposalRecord> {
    this.record = {
      id: input.id,
      status: ProposalStatus.PROPOSED,
      requestedBy: input.requestedBy,
      proposedAction: input.action,
    };
    return this.record;
  }
  public async findProposalById(): Promise<ProposalRecord | null> { return this.record; }
  public async claimForExecution(id: string, confirmedBy: string): Promise<ProposalRecord | null> {
    if (!this.record || this.record.id !== id || this.record.requestedBy !== confirmedBy || this.record.status !== ProposalStatus.PROPOSED) return null;
    this.record.status = ProposalStatus.CONFIRMED;
    return this.record;
  }
  public async markExecuted(): Promise<void> {
    if (this.record) this.record.status = ProposalStatus.EXECUTED;
  }
  public async markFailed(): Promise<void> {
    if (this.record) this.record.status = ProposalStatus.FAILED;
  }
  public async reject(): Promise<boolean> { return false; }
}

class FakeGithub implements GitHubAdapter {
  public writes = 0;
  public async listWorkItems() { return []; }
  public async applyProgressUpdate() {
    this.writes += 1;
    return { commentUrl: 'https://github.com/acme/api/issues/42#issuecomment-1', projectStatusUpdated: true };
  }
  public async checkConnection(): Promise<void> {}
}

class FakeAudit implements AuditStore {
  public entries: object[] = [];
  public async append(input: object): Promise<void> { this.entries.push(input); }
}

describe('progress confirmation boundary', () => {
  it('does not write before confirmation, then writes GitHub and Audit Log once', async () => {
    const proposals = new FakeProposals();
    const github = new FakeGithub();
    const audit = new FakeAudit();
    const reminders = new FakeReminders();
    const service = new ProgressProposalService(new FakePeople(), reminders, proposals, github, audit);

    const preview = await service.proposeStillWorking(reminders.reminder.id, person.discordUserId);
    expect(preview.preview).toContain('確認後才會寫入 GitHub');
    expect(github.writes).toBe(0);
    await expect(service.execute(preview.proposalId, 'unknown-user', 'request-denied')).rejects.toThrow();
    expect(github.writes).toBe(0);

    const result = await service.execute(preview.proposalId, person.discordUserId, 'request-1');
    expect(result).toContain('issuecomment-1');
    expect(github.writes).toBe(1);
    expect(audit.entries).toHaveLength(1);
    expect(proposals.record?.status).toBe(ProposalStatus.EXECUTED);
  });
});
