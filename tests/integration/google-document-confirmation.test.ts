import { ProposalStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  StructuredLlmRequest,
  StructuredLlmResponse,
  TextLlmRequest,
  TextLlmResponse,
} from '../../src/ai/contracts.js';
import type {
  GoogleDocsAdapter,
  GoogleDocumentEdit,
  GoogleDocumentSnapshot,
  LocatedDocumentTarget,
} from '../../src/google/adapters.js';
import {
  GoogleDocumentProposalService,
  type DocumentAction,
  type DocumentBindingRecord,
  type DocumentProposalRecord,
  type DocumentProposalStore,
} from '../../src/google/document-service.js';

class DocumentLlm implements LlmAdapter {
  public async generateStructured<T>(request: StructuredLlmRequest<T>): Promise<StructuredLlmResponse<T>> {
    return {
      data: request.schema.parse({
        targetType: 'marker',
        targetValue: '{{weekly_completed}}',
        mode: 'replace',
        content: 'Completed: webhook validation',
        rationale: 'Update the named weekly section.',
        confidence: 0.95,
        confirmedFacts: ['Webhook tests pass'],
        assumptions: [],
      }),
      model: 'fake',
      traceId: request.traceId,
    };
  }
  public async generateText(request: TextLlmRequest): Promise<TextLlmResponse> {
    return { text: 'unused', model: 'fake', traceId: request.traceId };
  }
  public async checkConnection(): Promise<void> {}
}

class FakeDocs implements GoogleDocsAdapter {
  public writes = 0;
  public before = 'Old weekly content';
  public readonly snapshot: GoogleDocumentSnapshot = {
    documentId: 'doc-1',
    title: 'Weekly Spec',
    revisionId: 'revision-1',
    spans: [{ startIndex: 1, endIndex: 30, text: '{{weekly_completed}}' }],
    namedRanges: {},
  };
  public async readDocument(): Promise<GoogleDocumentSnapshot> { return this.snapshot; }
  public locate(): LocatedDocumentTarget {
    return { startIndex: 1, endIndex: 20, before: this.before };
  }
  public async applyEdit(edit: GoogleDocumentEdit) {
    expect(edit.revisionId).toBe('revision-1');
    this.writes += 1;
    return { revisionId: 'revision-2' };
  }
  public async checkConnection(): Promise<void> {}
}

class FakeDocumentProposals implements DocumentProposalStore {
  public record: DocumentProposalRecord | null = null;
  public completed = false;
  public async create(input: { requestedBy: string; action: DocumentAction }): Promise<void> {
    this.record = { id: input.action.proposalId, requestedBy: input.requestedBy, status: ProposalStatus.PROPOSED, action: input.action };
  }
  public async find(): Promise<DocumentProposalRecord | null> { return this.record; }
  public async update(_id: string, _actor: string, changes: Partial<Pick<DocumentAction, 'mode' | 'content'>>): Promise<DocumentAction> {
    if (!this.record) throw new Error('missing');
    const action = { ...(this.record.action as DocumentAction), ...changes };
    this.record.action = action;
    return action;
  }
  public async claim(_id: string, actor: string): Promise<DocumentProposalRecord | null> {
    if (!this.record || this.record.requestedBy !== actor || this.record.status !== ProposalStatus.PROPOSED) return null;
    this.record.status = ProposalStatus.CONFIRMED;
    return this.record;
  }
  public async complete(): Promise<void> {
    this.completed = true;
    if (this.record) this.record.status = ProposalStatus.EXECUTED;
  }
  public async fail(): Promise<void> {
    if (this.record) this.record.status = ProposalStatus.FAILED;
  }
  public async reject(): Promise<boolean> { return false; }
}

const binding: DocumentBindingRecord = {
  id: '7eed3a5f-7850-436f-93e4-d34fb2128298',
  projectBindingId: '8b919beb-c796-4a45-9ba4-49e2374573b2',
  documentId: 'doc-1',
  documentUrl: 'https://docs.google.com/document/d/doc-1/edit',
  displayName: 'Weekly Spec',
  allowedOperations: ['comment', 'insert', 'replace'],
};

describe('Google document confirmation boundary', () => {
  it('previews a revision-locked diff and writes only after requestor confirmation', async () => {
    const docs = new FakeDocs();
    const proposals = new FakeDocumentProposals();
    const service = new GoogleDocumentProposalService(new DocumentLlm(), docs, proposals);
    const action = await service.prepare({
      requestedBy: 'discord-alice',
      prompt: '把結論補進文件',
      messages: [{ author: 'Alice', content: 'Webhook tests pass', createdAt: '2026-08-28T00:00:00Z', url: 'https://discord.com/channels/1/2/3' }],
      binding,
    });
    expect(action.before).toBe('Old weekly content');
    expect(docs.writes).toBe(0);
    await expect(service.execute(action.proposalId, 'discord-bob', 'denied')).rejects.toThrow();
    expect(docs.writes).toBe(0);
    await service.execute(action.proposalId, 'discord-alice', 'request-1');
    expect(docs.writes).toBe(1);
    expect(proposals.completed).toBe(true);
  });

  it('requires an explicit second confirmation for large replacements', async () => {
    const docs = new FakeDocs();
    docs.before = 'x'.repeat(5_000);
    const proposals = new FakeDocumentProposals();
    const service = new GoogleDocumentProposalService(new DocumentLlm(), docs, proposals);
    const action = await service.prepare({
      requestedBy: 'discord-alice', prompt: '更新整段', messages: [], binding,
    });
    expect(action.requiresSecondConfirmation).toBe(true);
    await expect(service.execute(action.proposalId, 'discord-alice', 'first')).rejects.toThrow('第二次確認');
    expect(docs.writes).toBe(0);
    await service.execute(action.proposalId, 'discord-alice', 'second', true);
    expect(docs.writes).toBe(1);
  });
});
