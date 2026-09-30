import { describe, expect, it } from 'vitest';
import type {
	LlmAdapter,
	StructuredLlmRequest,
	StructuredLlmResponse,
	TextLlmRequest,
	TextLlmResponse,
} from '../../src/ai/contracts.js';
import { aiNewsDigestInternals } from '../../src/ai-news/digest-service.js';
import { AiNewsLlmService } from '../../src/ai-news/llm-service.js';
import type { RankedNewsCandidate } from '../../src/ai-news/types.js';

class InventingLlm implements LlmAdapter {
	public async generateStructured<T>(request: StructuredLlmRequest<T>): Promise<StructuredLlmResponse<T>> {
		const invented = {
			items: [{
				candidateId: 'not-in-candidates',
				headline: '虛構消息',
				whatHappened: '虛構內容',
				whyImportant: '虛構理由',
				howToUse: '虛構用法',
			}],
		};
		return { data: request.schema.parse(invented), model: 'fake', traceId: request.traceId };
	}

	public async generateText(request: TextLlmRequest): Promise<TextLlmResponse> {
		return { text: 'unused', model: 'fake', traceId: request.traceId };
	}

	public async checkConnection(): Promise<void> {}
}

const rankedCandidate: RankedNewsCandidate = {
	id: 'allowed-id',
	provider: 'openai-news',
	category: 'newModel',
	brand: 'OpenAI',
	official: true,
	severity: 'major',
	title: 'OpenAI releases a new model',
	publishedAt: new Date('2026-08-31T01:00:00.000Z'),
	canonicalUrl: 'https://openai.com/news/model',
	sourceUrl: 'https://openai.com/news/model',
	engagement: {},
	evidenceUrls: ['https://openai.com/news/model'],
	sourceSummary: 'Official model release notes.',
	rankingScore: 90,
	scoreBreakdown: { relevance: 100, impact: 90, evidence: 100, momentum: 30, recency: 100 },
};

describe('AI news digest', () => {
	it('skips weekend dates in the configured timezone', () => {
		expect(aiNewsDigestInternals.isWeekend(new Date('2026-09-05T01:00:00.000Z'), 'Asia/Taipei')).toBe(true);
		expect(aiNewsDigestInternals.isWeekend(new Date('2026-09-07T01:00:00.000Z'), 'Asia/Taipei')).toBe(false);
	});

	it('continues from Friday on Monday and caps stale recovery at 96 hours', () => {
		const monday = new Date('2026-09-07T01:00:00.000Z');
		const friday = new Date('2026-09-04T01:00:00.000Z');
		expect(aiNewsDigestInternals.digestWindowStart(monday, friday, 72, 96)).toEqual(friday);
		expect(aiNewsDigestInternals.digestWindowStart(monday, new Date('2026-09-01T01:00:00.000Z'), 72, 96))
			.toEqual(new Date('2026-09-03T01:00:00.000Z'));
		expect(aiNewsDigestInternals.digestWindowStart(monday, null, 72, 96))
			.toEqual(new Date('2026-09-04T01:00:00.000Z'));
	});

	it('discards invented candidate IDs and falls back to supplied evidence', async () => {
		const summaries = await new AiNewsLlmService(new InventingLlm()).summarizeDigest([rankedCandidate], 'trace');
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.candidateId).toBe('allowed-id');
		expect(summaries[0]?.headline).toBe(rankedCandidate.title);
	});
});
