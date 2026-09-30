import { describe, expect, it } from 'vitest';
import { selectNewsCandidates } from '../../src/ai-news/ranking.js';
import type { NewsCandidate } from '../../src/ai-news/types.js';
import { newsUrlHash } from '../../src/ai-news/url.js';

function candidate(input: Partial<NewsCandidate> & Pick<NewsCandidate, 'id' | 'title' | 'canonicalUrl'>): NewsCandidate {
	return {
		provider: 'test',
		category: 'newModel',
		official: true,
		severity: 'major',
		publishedAt: new Date('2026-09-01T00:00:00.000Z'),
		sourceUrl: input.canonicalUrl,
		engagement: { score: 100, comments: 20 },
		evidenceUrls: [input.canonicalUrl],
		sourceSummary: 'New generative AI model with multimodal agent capabilities.',
		...input,
	};
}

describe('AI news ranking', () => {
	it('deduplicates the same event and limits a category to two items', () => {
		const items = [
			candidate({ id: '1', title: 'OpenAI releases GPT Next model', canonicalUrl: 'https://openai.com/a', brand: 'OpenAI', severity: 'normal' }),
			candidate({ id: '2', title: 'OpenAI releases the GPT Next model today', canonicalUrl: 'https://news.example.com/a', severity: 'normal' }),
			candidate({ id: '3', title: 'Claude Opus model released', canonicalUrl: 'https://anthropic.com/a', brand: 'Anthropic', severity: 'normal' }),
			candidate({ id: '4', title: 'Hugging Face releases a new model', canonicalUrl: 'https://huggingface.co/a', brand: 'Hugging Face', severity: 'normal' }),
		];
		const selected = selectNewsCandidates(items, new Date('2026-09-01T01:00:00.000Z'), new Set(), newsUrlHash);
		expect(selected.filter((item) => item.category === 'newModel')).toHaveLength(2);
		expect(selected.some((item) => item.id === '2')).toBe(false);
	});

	it('keeps one major official event for each watched brand when all three occur', () => {
		const items = [
			candidate({ id: 'openai', title: 'OpenAI flagship model release', canonicalUrl: 'https://openai.com/major', brand: 'OpenAI' }),
			candidate({ id: 'anthropic', title: 'Claude flagship model release', canonicalUrl: 'https://anthropic.com/major', brand: 'Anthropic' }),
			candidate({ id: 'hugging-face', title: 'Hugging Face flagship model release', canonicalUrl: 'https://huggingface.co/major', brand: 'Hugging Face' }),
		];
		const selected = selectNewsCandidates(items, new Date('2026-09-01T01:00:00.000Z'), new Set(), newsUrlHash);
		expect(new Set(selected.map((item) => item.brand))).toEqual(new Set(['OpenAI', 'Anthropic', 'Hugging Face']));
	});

	it('keeps a major official service incident even without general AI keywords', () => {
		const outage = candidate({
			id: 'outage',
			title: 'Elevated error rates',
			canonicalUrl: 'https://status.claude.com/incident',
			brand: 'Anthropic',
			category: 'serviceIncident',
			sourceSummary: 'Impact level major; duration 90 minutes.',
		});
		expect(selectNewsCandidates([outage], new Date('2026-09-01T01:00:00.000Z'), new Set(), newsUrlHash))
			.toHaveLength(1);
	});

	it('filters recently published URLs unless the event is critical', () => {
		const normal = candidate({ id: '1', title: 'New AI model', canonicalUrl: 'https://example.com/normal', severity: 'major' });
		const critical = candidate({ id: '2', title: 'Critical AI security incident', canonicalUrl: 'https://example.com/critical', category: 'securityIncident', severity: 'critical' });
		const recent = new Set([newsUrlHash(normal.canonicalUrl), newsUrlHash(critical.canonicalUrl)]);
		const selected = selectNewsCandidates([normal, critical], new Date('2026-09-01T01:00:00.000Z'), recent, newsUrlHash);
		expect(selected.map((item) => item.id)).toEqual(['2']);
	});

	it('does not treat ordinary words containing the letters ai as AI evidence', () => {
		const unrelated = candidate({
			id: 'unrelated',
			title: 'Thailand railway training schedule',
			canonicalUrl: 'https://example.com/railway',
			official: false,
			severity: 'normal',
			sourceSummary: 'A transportation timetable update.',
		});
		expect(selectNewsCandidates([unrelated], new Date('2026-09-01T01:00:00.000Z'), new Set(), newsUrlHash))
			.toHaveLength(0);
	});
});
