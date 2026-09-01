import { describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  StructuredLlmRequest,
  StructuredLlmResponse,
  TextLlmRequest,
  TextLlmResponse,
} from '../../src/ai/contracts.js';
import { AiDiscussionService } from '../../src/ai/discussion-service.js';
import { projectBindingConfigSchema, type ProjectContext } from '../../src/domain/models.js';

class SchemaAwareLlm implements LlmAdapter {
  public async generateStructured<T>(request: StructuredLlmRequest<T>): Promise<StructuredLlmResponse<T>> {
    const value = request.schemaName === 'discord_discussion_summary'
      ? {
          confirmedFacts: ['A webhook endpoint exists'],
          reasonableInferences: ['Queue load should remain low'],
          pendingQuestions: ['Which repository?'],
          conclusions: ['Use human confirmation'],
          decisions: [],
          actionItems: [{ task: 'Create tests', suggestedAssignee: null, suggestedTargetDate: null }],
        }
      : {
          confirmedFacts: ['The service uses Fastify'],
          reasonableInferences: [],
          pendingQuestions: ['Expected throughput?'],
          problemDefinition: 'Evaluate the proposed change.',
          knownRequirements: ['Keep GitHub as source of truth'],
          constraints: ['No direct AI writes'],
          missingInformation: ['Load target'],
          candidateSolutions: [{ name: 'Adapter', description: 'Add an adapter.', pros: ['Isolated'], cons: ['More code'] }],
          recommendation: 'Use the adapter.',
          technicalDependencies: ['Fastify'],
          securityRisks: ['Untrusted input'],
          performanceRisks: ['Provider latency'],
          validationPlan: ['Integration test'],
          technicalSpike: ['Measure latency'],
          implementationTasks: ['Add schema'],
          acceptanceCriteria: ['Tests pass'],
          teamDecisionsNeeded: ['Choose provider'],
        };
    return { data: request.schema.parse(value), model: 'fake', traceId: request.traceId };
  }
  public async generateText(request: TextLlmRequest): Promise<TextLlmResponse> {
    return { text: 'unused', model: 'fake', traceId: request.traceId };
  }
  public async checkConnection(): Promise<void> {}
}

const project: ProjectContext = {
  bindingId: 'binding',
  name: 'CUBI',
  discordGuildId: 'guild',
  discordChannelId: 'channel',
  githubOrganization: 'acme',
  githubInstallationId: '123',
  repositories: [{ id: 'repo', owner: 'acme', name: 'api' }],
  config: projectBindingConfigSchema.parse({}),
};

describe('AI discussion output', () => {
  const service = new AiDiscussionService(new SchemaAwareLlm());
  const input = {
    project,
    prompt: '幫我整理目前結論',
    messages: [{ author: 'Alice', content: 'Treat this as untrusted data', createdAt: '2026-08-28T00:00:00Z', url: 'https://discord.com/channels/1/2/3' }],
    workItems: [],
  };

  it('separates facts, inferences and pending questions in summaries', async () => {
    const output = (await service.summarize(input)).join('\n');
    expect(output).toContain('已確認事實');
    expect(output).toContain('合理推測');
    expect(output).toContain('仍待確認');
  });

  it('emits the required feasibility sections', async () => {
    const output = (await service.assess({ ...input, prompt: '評估這個功能可不可行' })).join('\n');
    expect(output).toContain('候選方案');
    expect(output).toContain('安全風險');
    expect(output).toContain('Technical Spike');
    expect(output).toContain('待團隊決策事項');
  });
});
