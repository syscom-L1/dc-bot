import { z } from 'zod';
import { candidateId, canonicalizeNewsUrl } from './url.js';
import type { AiNewsCategory, AiNewsSeverity, NewsCandidate, NewsSourceAdapter } from './types.js';

const sourceTimeoutMs = 10_000;
const maxSourceBytes = 10_000_000;

function decodeEntities(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
		.replace(/&amp;/giu, '&')
		.replace(/&quot;/giu, '"')
		.replace(/&#39;|&apos;/giu, "'")
		.replace(/&lt;/giu, '<')
		.replace(/&gt;/giu, '>')
		.replace(/<[^>]+>/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

async function fetchText(url: string): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), sourceTimeoutMs);
	try {
		const response = await fetch(url, {
			headers: {
				accept: 'application/json, application/rss+xml, application/atom+xml, text/html',
				'user-agent': 'dc-bot-ai-news/1.0',
			},
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const declaredLength = Number(response.headers.get('content-length') ?? 0);
		if (declaredLength > maxSourceBytes) throw new Error('source response exceeds size limit');
		if (!response.body) return '';
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			const chunk = z.instanceof(Uint8Array).parse(result.value);
			totalBytes += chunk.byteLength;
			if (totalBytes > maxSourceBytes) {
				controller.abort();
				throw new Error('source response exceeds size limit');
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
	} finally {
		clearTimeout(timer);
	}
}

function tag(block: string, names: string[]): string {
	for (const name of names) {
		const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'iu').exec(block);
		if (match?.[1]) return decodeEntities(match[1]);
	}
	return '';
}

function linkFromFeedBlock(block: string): string {
	const rssLink = tag(block, ['link']);
	if (/^https?:\/\//iu.test(rssLink)) return rssLink;
	const atomLink = /<link[^>]+href=["']([^"']+)["']/iu.exec(block)?.[1];
	return atomLink ? decodeEntities(atomLink) : '';
}

function categoryFor(value: string): AiNewsCategory {
	const text = value.toLowerCase();
	if (/breach|cve|exploit|injection|security|vulnerability|資安|漏洞/u.test(text)) return 'securityIncident';
	if (/degraded|downtime|incident|outage|中斷|異常/u.test(text)) return 'serviceIncident';
	if (/model|checkpoint|weights|模型|權重/u.test(text)) return 'newModel';
	if (/paper|architecture|benchmark|inference|quantization|research|technique|研究|推論|量化/u.test(text)) return 'newTechnique';
	if (/agent|demo|repository|tool|workflow|use case|使用方式|工作流/u.test(text)) return 'newUsage';
	if (/api|chatgpt|claude|pricing|product|release|feature|產品|價格|功能/u.test(text)) return 'productUpdate';
	return 'industryEvent';
}

function severityFor(value: string): AiNewsSeverity {
	const text = value.toLowerCase();
	if (/critical|data breach|重大漏洞|資料外洩/u.test(text)) return 'critical';
	if (/flagship|major|outage|pricing|重大|旗艦|中斷|價格/u.test(text)) return 'major';
	return 'normal';
}

function brandFor(value: string): NewsCandidate['brand'] {
	const text = value.toLowerCase();
	if (/openai|chatgpt|gpt-/u.test(text)) return 'OpenAI';
	if (/anthropic|claude/u.test(text)) return 'Anthropic';
	if (/hugging\s*face|huggingface/u.test(text)) return 'Hugging Face';
	return undefined;
}

function parseDate(value: string): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function withinWindow(value: Date, start: Date, end: Date): boolean {
	return value.getTime() >= start.getTime() && value.getTime() <= end.getTime();
}

interface FeedOptions {
	name: string;
	url: string;
	official: boolean;
	brand?: NewsCandidate['brand'];
	defaultCategory?: AiNewsCategory;
	minimumOutageMinutes?: number;
}

function durationMinutesFromText(value: string): number {
	const hours = Number(/(\d+(?:\.\d+)?)\s*hours?/iu.exec(value)?.[1] ?? 0);
	const minutes = Number(/(\d+(?:\.\d+)?)\s*minutes?/iu.exec(value)?.[1] ?? 0);
	return hours * 60 + minutes;
}

export class FeedNewsSource implements NewsSourceAdapter {
	public readonly name: string;

	public constructor(private readonly options: FeedOptions) {
		this.name = options.name;
	}

	public async listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const xml = await fetchText(this.options.url);
		const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/giu) ?? [];
		return blocks.flatMap((block) => {
			const title = tag(block, ['title']);
			const sourceUrl = linkFromFeedBlock(block);
			if (!title || !sourceUrl) return [];
			let canonicalUrl: string;
			try {
				canonicalUrl = canonicalizeNewsUrl(sourceUrl);
			} catch {
				return [];
			}
			const publishedAt = parseDate(tag(block, ['pubDate', 'published', 'updated', 'dc:date']));
			if (!publishedAt) return [];
			if (!withinWindow(publishedAt, windowStart, windowEnd)) return [];
			const sourceSummary = tag(block, ['description', 'summary', 'content:encoded', 'content']).slice(0, 2_000);
			const combined = `${title} ${sourceSummary}`;
			const severity = severityFor(combined);
			if (this.options.minimumOutageMinutes
				&& severity === 'normal'
				&& durationMinutesFromText(combined) < this.options.minimumOutageMinutes) {
				return [];
			}
			const brand = this.options.brand ?? brandFor(combined);
			return [{
				id: candidateId(this.options.name, canonicalUrl),
				provider: this.options.name,
				category: this.options.defaultCategory ?? categoryFor(combined),
				...(brand ? { brand } : {}),
				official: this.options.official,
				severity,
				title,
				publishedAt,
				canonicalUrl,
				sourceUrl: canonicalUrl,
				engagement: {},
				evidenceUrls: [canonicalUrl],
				sourceSummary,
			} satisfies NewsCandidate];
		});
	}
}

const hackerNewsItemSchema = z.object({
	id: z.number(),
	type: z.string().optional(),
	time: z.number(),
	title: z.string(),
	url: z.string().url().optional(),
	score: z.number().optional(),
	descendants: z.number().optional(),
});

export class HackerNewsSource implements NewsSourceAdapter {
	public readonly name = 'hacker-news';

	public async listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const ids = z.array(z.number()).parse(JSON.parse(await fetchText(
			'https://hacker-news.firebaseio.com/v0/beststories.json',
		))).slice(0, 50);
		const items = await Promise.all(ids.map(async (id) => {
			try {
				return hackerNewsItemSchema.parse(JSON.parse(await fetchText(
					`https://hacker-news.firebaseio.com/v0/item/${id}.json`,
				)));
			} catch {
				return null;
			}
		}));
		return items.flatMap((item) => {
			if (!item || item.type !== 'story') return [];
			const publishedAt = new Date(item.time * 1_000);
			if (!withinWindow(publishedAt, windowStart, windowEnd)) return [];
			const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;
			const sourceUrl = item.url ?? discussionUrl;
			let canonicalUrl: string;
			try {
				canonicalUrl = canonicalizeNewsUrl(sourceUrl);
			} catch {
				return [];
			}
			const brand = brandFor(item.title);
			return [{
				id: candidateId(this.name, canonicalUrl),
				provider: this.name,
				category: categoryFor(item.title),
				...(brand ? { brand } : {}),
				official: false,
				severity: severityFor(item.title),
				title: decodeEntities(item.title),
				publishedAt,
				canonicalUrl,
				sourceUrl: discussionUrl,
				engagement: {
					...(item.score === undefined ? {} : { score: item.score }),
					...(item.descendants === undefined ? {} : { comments: item.descendants }),
				},
				evidenceUrls: [canonicalUrl, discussionUrl],
				sourceSummary: `Hacker News：${item.score ?? 0} 分，${item.descendants ?? 0} 則留言。`,
			} satisfies NewsCandidate];
		});
	}
}

const huggingFaceModelSchema = z.array(z.object({
	id: z.string(),
	createdAt: z.string().optional(),
	lastModified: z.string().optional(),
	downloads: z.number().optional(),
	likes: z.number().optional(),
	tags: z.array(z.string()).optional(),
}));

export class HuggingFaceModelsSource implements NewsSourceAdapter {
	public readonly name = 'hugging-face-models';

	public async listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const models = huggingFaceModelSchema.parse(JSON.parse(await fetchText(
			'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=30&full=true',
		)));
		return models.flatMap((model) => {
			const publishedAt = parseDate(model.createdAt ?? model.lastModified ?? '');
			if (!publishedAt) return [];
			if (!withinWindow(publishedAt, windowStart, windowEnd)) return [];
			const canonicalUrl = `https://huggingface.co/${model.id}`;
			const sourceSummary = `Model Card；標籤：${(model.tags ?? []).slice(0, 8).join('、')}`;
			return [{
				id: candidateId(this.name, canonicalUrl),
				provider: this.name,
				category: 'newModel',
				brand: 'Hugging Face',
				official: true,
				severity: severityFor(model.id),
				title: model.id,
				publishedAt,
				canonicalUrl,
				sourceUrl: canonicalUrl,
				engagement: {
					...(model.downloads === undefined ? {} : { downloads: model.downloads }),
					...(model.likes === undefined ? {} : { likes: model.likes }),
				},
				evidenceUrls: [canonicalUrl],
				sourceSummary,
			} satisfies NewsCandidate];
		});
	}
}

const dailyPaperSchema = z.array(z.object({
	title: z.string(),
	publishedAt: z.string().optional(),
	upvotes: z.number().optional(),
	paper: z.object({
		id: z.string(),
		summary: z.string().optional(),
		publishedAt: z.string().optional(),
		submittedOnDailyAt: z.string().optional(),
		upvotes: z.number().optional(),
	}).optional(),
}).passthrough());

export class HuggingFacePapersSource implements NewsSourceAdapter {
	public readonly name = 'hugging-face-papers';

	public async listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const papers = dailyPaperSchema.parse(JSON.parse(await fetchText('https://huggingface.co/api/daily_papers')));
		return papers.flatMap((paper) => {
			const paperId = paper.paper?.id;
			if (!paperId) return [];
			const publishedAt = parseDate(
				paper.paper?.submittedOnDailyAt ?? paper.paper?.publishedAt ?? paper.publishedAt ?? '',
			);
			if (!publishedAt) return [];
			if (!withinWindow(publishedAt, windowStart, windowEnd)) return [];
			const canonicalUrl = `https://huggingface.co/papers/${paperId}`;
			return [{
				id: candidateId(this.name, canonicalUrl),
				provider: this.name,
				category: 'newTechnique',
				brand: 'Hugging Face',
				official: true,
				severity: 'normal',
				title: paper.title,
				publishedAt,
				canonicalUrl,
				sourceUrl: canonicalUrl,
				engagement: (paper.paper?.upvotes ?? paper.upvotes) === undefined
					? {}
					: { likes: paper.paper?.upvotes ?? paper.upvotes ?? 0 },
				evidenceUrls: [canonicalUrl, `https://arxiv.org/abs/${paperId}`],
				sourceSummary: (paper.paper?.summary ?? 'Hugging Face Daily Papers 收錄論文。').slice(0, 2_000),
			} satisfies NewsCandidate];
		});
	}
}

export class GitHubTrendingSource implements NewsSourceAdapter {
	public readonly name = 'github-trending';

	public async listCandidates(_windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const html = await fetchText('https://github.com/trending?since=daily');
		const articleBlocks = html.match(/<article[^>]+Box-row[^>]*>[\s\S]*?<\/article>/giu) ?? [];
		return articleBlocks.slice(0, 25).flatMap((block) => {
			const repository = /<h2[^>]*>[\s\S]*?<a[^>]+href=["']\/([^"']+)["']/iu.exec(block)?.[1]?.replace(/\s+/gu, '');
			if (!repository) return [];
			const description = decodeEntities(/<p[^>]*>([\s\S]*?)<\/p>/iu.exec(block)?.[1] ?? '');
			const combined = `${repository} ${description}`;
			if (!generativeAiRelated(combined)) return [];
			const canonicalUrl = `https://github.com/${repository}`;
			const brand = brandFor(combined);
			return [{
				id: candidateId(this.name, canonicalUrl),
				provider: this.name,
				category: 'newUsage',
				...(brand ? { brand } : {}),
				official: false,
				severity: 'normal',
				title: repository,
				publishedAt: windowEnd,
				canonicalUrl,
				sourceUrl: 'https://github.com/trending?since=daily',
				engagement: {},
				evidenceUrls: [canonicalUrl],
				sourceSummary: description,
			} satisfies NewsCandidate];
		});
	}
}

export class OfficialNewsPageSource implements NewsSourceAdapter {
	public readonly name: string;

	public constructor(
		name: string,
		private readonly pageUrl: string,
		private readonly brand: NonNullable<NewsCandidate['brand']>,
	) {
		this.name = name;
	}

	public async listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const html = await fetchText(this.pageUrl);
		const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
		const candidates: NewsCandidate[] = [];
		for (const match of html.matchAll(linkPattern)) {
			const href = match[1];
			const title = decodeEntities(match[2] ?? '');
			if (!href || title.length < 8 || !href.includes('/news/')) continue;
			const contextStart = Math.max(0, (match.index ?? 0) - 300);
			const context = decodeEntities(html.slice(contextStart, (match.index ?? 0) + match[0].length + 300));
			const dateText = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/iu.exec(context)?.[0];
			if (!dateText) continue;
			const publishedAt = parseDate(dateText);
			if (!publishedAt) continue;
			if (!withinWindow(publishedAt, windowStart, windowEnd)) continue;
			let canonicalUrl: string;
			try {
				canonicalUrl = canonicalizeNewsUrl(new URL(href, this.pageUrl).toString());
			} catch {
				continue;
			}
			candidates.push({
				id: candidateId(this.name, canonicalUrl),
				provider: this.name,
				category: categoryFor(`${title} ${context}`),
				brand: this.brand,
				official: true,
				severity: severityFor(`${title} ${context}`),
				title,
				publishedAt,
				canonicalUrl,
				sourceUrl: canonicalUrl,
				engagement: {},
				evidenceUrls: [canonicalUrl],
				sourceSummary: context.slice(0, 1_000),
			});
		}
		return [...new Map(candidates.map((candidate) => [candidate.canonicalUrl, candidate])).values()];
	}
}

const statusPageSchema = z.object({
	incidents: z.array(z.object({
		id: z.string(),
		name: z.string(),
		impact: z.enum(['none', 'minor', 'major', 'critical']).catch('none'),
		created_at: z.string(),
		resolved_at: z.string().nullable().optional(),
		shortlink: z.string().url().optional(),
		incident_updates: z.array(z.object({ body: z.string() })).optional(),
	})),
});

export class StatusPageSource implements NewsSourceAdapter {
	public readonly name: string;

	public constructor(
		name: string,
		private readonly statusBaseUrl: string,
		private readonly brand: NonNullable<NewsCandidate['brand']>,
		private readonly majorOutageMinutes: number,
	) {
		this.name = name;
	}

	public async listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]> {
		const payload = statusPageSchema.parse(JSON.parse(await fetchText(`${this.statusBaseUrl}/api/v2/incidents.json`)));
		return payload.incidents.flatMap((incident) => {
			const publishedAt = parseDate(incident.created_at);
			if (!publishedAt) return [];
			if (!withinWindow(publishedAt, windowStart, windowEnd)) return [];
			const resolvedAt = incident.resolved_at ? parseDate(incident.resolved_at) : windowEnd;
			if (!resolvedAt) return [];
			const durationMinutes = Math.max(0, resolvedAt.getTime() - publishedAt.getTime()) / 60_000;
			if (incident.impact !== 'major' && incident.impact !== 'critical' && durationMinutes < this.majorOutageMinutes) {
				return [];
			}
			const canonicalUrl = incident.shortlink ?? `${this.statusBaseUrl}/incidents/${incident.id}`;
			const sourceSummary = `${incident.incident_updates?.[0]?.body ?? ''} 影響等級：${incident.impact}；持續約 ${Math.round(durationMinutes)} 分鐘。`;
			return [{
				id: candidateId(this.name, canonicalUrl),
				provider: this.name,
				category: 'serviceIncident',
				brand: this.brand,
				official: true,
				severity: incident.impact === 'critical' ? 'critical' : 'major',
				title: incident.name,
				publishedAt,
				canonicalUrl,
				sourceUrl: canonicalUrl,
				engagement: {},
				evidenceUrls: [canonicalUrl],
				sourceSummary,
			} satisfies NewsCandidate];
		});
	}
}

function generativeAiRelated(value: string): boolean {
	return /agent|chatgpt|claude|diffusion|generative|huggingface|llm|multimodal|openai|rag|transformer/iu.test(value);
}

export function createDefaultNewsSources(primarySourceUrl: string, majorOutageMinutes: number): NewsSourceAdapter[] {
	return [
		new FeedNewsSource({ name: 'ai-news', url: primarySourceUrl, official: false }),
		new FeedNewsSource({ name: 'openai-news', url: 'https://openai.com/news/rss.xml', official: true, brand: 'OpenAI' }),
		new StatusPageSource('openai-status', 'https://status.openai.com', 'OpenAI', majorOutageMinutes),
		new OfficialNewsPageSource('anthropic-news', 'https://www.anthropic.com/news', 'Anthropic'),
		new StatusPageSource('claude-status', 'https://status.claude.com', 'Anthropic', majorOutageMinutes),
		new FeedNewsSource({ name: 'hugging-face-blog', url: 'https://huggingface.co/blog/feed.xml', official: true, brand: 'Hugging Face' }),
		new FeedNewsSource({
			name: 'hugging-face-status',
			url: 'https://status.huggingface.co/feed.rss',
			official: true,
			brand: 'Hugging Face',
			defaultCategory: 'serviceIncident',
			minimumOutageMinutes: majorOutageMinutes,
		}),
		new HuggingFacePapersSource(),
		new HuggingFaceModelsSource(),
		new HackerNewsSource(),
		new GitHubTrendingSource(),
	];
}
