import { ProposalStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  StructuredLlmRequest,
  StructuredLlmResponse,
  TextLlmRequest,
  TextLlmResponse,
} from '../../src/ai/contracts.js';
import { projectBindingConfigSchema, type ProjectContext } from '../../src/domain/models.js';
import { IssueDraftService, type IssueDraft } from '../../src/issues/issue-draft.js';
import {
  IssueCreationService,
  type GitHubIssueWriter,
  type IssueCreationAction,
  type IssueProposalRecord,
  type IssueProposalStore,
} from '../../src/issues/issue-creation.js';

const draft: IssueDraft = {
  title: 'Create message-to-Issue flow',
  background: 'The team loses tasks after Discord discussions.',
  goal: 'Create a confirmed GitHub Issue from selected messages.',
  scope: ['Generate a structured draft', 'Require confirmation'],
  outOfScope: ['Automatic creation from ambiguous chat'],
  implementationNotes: ['Use the existing proposal boundary'],
  acceptanceCriteria: ['No Issue exists before confirmation', 'Confirmed proposal creates one Issue'],
  dependencies: [],
  risks: ['Prompt injection in source messages'],
  suggestedAssignee: 'alice',
  suggestedTargetDate: '2026-09-01',
  confidence: 0.9,
  assumptions: ['Repository selection uses the first bound repository'],
};

class FakeLlm implements LlmAdapter {
  public async generateStructured<T>(request: StructuredLlmRequest<T>): Promise<StructuredLlmResponse<T>> {
    return { data: request.schema.parse(draft), model: 'fake', traceId: request.traceId };
  }
  public async generateText(request: TextLlmRequest): Promise<TextLlmResponse> {
    return { text: 'unused', model: 'fake', traceId: request.traceId };
  }
  public async checkConnection(): Promise<void> {}
}

class FakeIssueProposals implements IssueProposalStore {
  public record: IssueProposalRecord | null = null;
  public completed = false;

  public async create(input: { proposalId: string; requestedBy: string; action: IssueCreationAction }): Promise<void> {
    this.record = { id: input.proposalId, requestedBy: input.requestedBy, status: ProposalStatus.PROPOSED, action: input.action };
  }
  public async find(): Promise<IssueProposalRecord | null> { return this.record; }
  public async updateDraft(_id: string, _actor: string, title: string, body: string): Promise<IssueCreationAction> {
    if (!this.record) throw new Error('missing');
    const action = { ...(this.record.action as IssueCreationAction), title, body };
    this.record.action = action;
    return action;
  }
  public async claim(id: string, actor: string): Promise<IssueProposalRecord | null> {
    if (!this.record || this.record.id !== id || this.record.requestedBy !== actor || this.record.status !== ProposalStatus.PROPOSED) return null;
    this.record.status = ProposalStatus.CONFIRMED;
    return this.record;
  }
  public async complete(): Promise<void> {
    this.completed = true;
    if (this.record) this.record.status = ProposalStatus.EXECUTED;
  }
  public async markFailed(): Promise<void> {
    if (this.record) this.record.status = ProposalStatus.FAILED;
  }
  public async reject(): Promise<boolean> { return false; }
}

class FakeIssueWriter implements GitHubIssueWriter {
  public writes = 0;
  public async createIssue(): Promise<{ issueNumber: number; issueUrl: string }> {
    this.writes += 1;
    return { issueNumber: 101, issueUrl: 'https://github.com/acme/api/issues/101' };
  }
}

const project: ProjectContext = {
  bindingId: 'fd9b06b8-f87a-435c-a5f4-60ff708ef8e0',
  name: 'CUBI',
  discordGuildId: 'guild',
  discordChannelId: 'channel',
  githubOrganization: 'acme',
  githubProjectId: 'PVT_1',
  githubInstallationId: '123',
  repositories: [{ id: 'repo', owner: 'acme', name: 'api' }],
  config: projectBindingConfigSchema.parse({}),
};

describe('Discord message to GitHub Issue boundary', () => {
  it('generates a validated proposal and writes only after the requestor confirms', async () => {
    const source = [{
      id: 'message-1',
      authorId: 'discord-alice',
      authorName: 'Alice',
      content: 'We should turn this into a task.',
      url: 'https://discord.com/channels/guild/channel/message-1',
      createdAt: '2026-08-28T03:00:00.000Z',
    }];
    const generated = await new IssueDraftService(new FakeLlm()).generate(project, source, 'discord-alice');
    expect(generated.draft.title).toBe(draft.title);

    const proposals = new FakeIssueProposals();
    const writer = new FakeIssueWriter();
    const service = new IssueCreationService(proposals, writer);
    const action = await service.saveDraft({
      proposalId: generated.proposalId,
      requestedBy: 'discord-alice',
      traceId: generated.traceId,
      draft: generated.draft,
      bindingId: project.bindingId,
      installationId: project.githubInstallationId,
      discordGuildId: project.discordGuildId,
      discordChannelId: project.discordChannelId,
      discordThreadId: null,
      sourceMessageId: 'message-1',
      owner: generated.repository.owner,
      repository: generated.repository.name,
      projectId: project.githubProjectId,
      targetDateFieldName: 'Target Date',
      sources: source,
    });
    expect(action.body).toContain('## Acceptance Criteria');
    expect(writer.writes).toBe(0);
    await expect(service.execute(generated.proposalId, 'discord-bob', 'denied')).rejects.toThrow();
    expect(writer.writes).toBe(0);

    const url = await service.execute(generated.proposalId, 'discord-alice', 'request-1');
    expect(url).toContain('/issues/101');
    expect(writer.writes).toBe(1);
    expect(proposals.completed).toBe(true);
  });
});
