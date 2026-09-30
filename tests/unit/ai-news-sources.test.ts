import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedNewsSource, HuggingFacePapersSource } from '../../src/ai-news/sources.js';

describe('AI news source adapters', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('uses the Hugging Face daily submission time instead of the older paper date', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
			title: 'A new generative AI technique',
			publishedAt: '2026-08-20T00:00:00.000Z',
			paper: {
				id: '2608.12345',
				publishedAt: '2026-08-20T00:00:00.000Z',
				submittedOnDailyAt: '2026-09-01T00:00:00.000Z',
				summary: 'A reproducible transformer inference technique.',
				upvotes: 42,
			},
		}]), { status: 200 })));
		const candidates = await new HuggingFacePapersSource().listCandidates(
			new Date('2026-08-31T00:00:00.000Z'),
			new Date('2026-09-01T01:00:00.000Z'),
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.publishedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
		expect(candidates[0]?.engagement.likes).toBe(42);
	});

	it('filters short status events below the configured outage threshold', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(`<?xml version="1.0"?>
<rss><channel>
<item><title>Short incident</title><link>https://status.example/short</link><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate><description>Degraded for 20 minutes</description></item>
<item><title>Long incident</title><link>https://status.example/long</link><pubDate>Tue, 01 Sep 2026 00:10:00 GMT</pubDate><description>Degraded for 1 hour and 20 minutes</description></item>
</channel></rss>`, { status: 200 })));
		const source = new FeedNewsSource({
			name: 'status-test',
			url: 'https://status.example/feed.rss',
			official: true,
			brand: 'Hugging Face',
			defaultCategory: 'serviceIncident',
			minimumOutageMinutes: 60,
		});
		const candidates = await source.listCandidates(
			new Date('2026-08-31T00:00:00.000Z'),
			new Date('2026-09-01T01:00:00.000Z'),
		);
		expect(candidates.map((candidate) => candidate.title)).toEqual(['Long incident']);
	});
});
