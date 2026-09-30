import type { AiNewsCategory, NewsCandidate, RankedNewsCandidate } from './types.js';

const generativeAiTerms = [
	'ai', 'agent', 'agents', 'anthropic', 'chatgpt', 'claude', 'deepseek', 'diffusion', 'embedding',
	'gemini', 'generative', 'gpt', 'hugging face', 'inference', 'llama', 'llm', 'mistral', 'model',
	'models', 'multimodal', 'openai', 'qwen', 'rag', 'transformer',
];
const majorTerms = [
	'critical', 'data breach', 'flagship', 'general availability', 'major', 'outage', 'pricing',
	'released', 'security', '重大', '發布', '洩漏', '資安',
];

function clamp(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function textFor(candidate: NewsCandidate): string {
	return `${candidate.title} ${candidate.sourceSummary}`.toLowerCase();
}

function includesTerm(text: string, term: string): boolean {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(text);
}

function relevance(candidate: NewsCandidate): number {
	const text = textFor(candidate);
	const matches = generativeAiTerms.filter((term) => includesTerm(text, term)).length;
	return clamp(35 + matches * 13 + (candidate.brand ? 15 : 0));
}

function impact(candidate: NewsCandidate): number {
	const text = textFor(candidate);
	const categoryBoost: Partial<Record<AiNewsCategory, number>> = {
		newModel: 25,
		securityIncident: 30,
		serviceIncident: 20,
		productUpdate: 12,
	};
	return clamp(
		35
		+ (categoryBoost[candidate.category] ?? 10)
		+ (candidate.severity === 'critical' ? 30 : candidate.severity === 'major' ? 20 : 0)
		+ (majorTerms.some((term) => text.includes(term)) ? 15 : 0),
	);
}

function evidence(candidate: NewsCandidate): number {
	return clamp(30 + (candidate.official ? 45 : 0) + Math.min(candidate.evidenceUrls.length, 3) * 10);
}

function momentum(candidate: NewsCandidate): number {
	const { score = 0, comments = 0, likes = 0, downloads = 0 } = candidate.engagement;
	return clamp(Math.log10(1 + score + comments * 2 + likes * 3 + downloads / 100) * 24);
}

function recency(candidate: NewsCandidate, windowEnd: Date): number {
	const ageHours = Math.max(0, windowEnd.getTime() - candidate.publishedAt.getTime()) / 3_600_000;
	return clamp(100 - ageHours * 2.5);
}

export function rankCandidate(candidate: NewsCandidate, windowEnd: Date): RankedNewsCandidate {
	const scoreBreakdown = {
		relevance: relevance(candidate),
		impact: impact(candidate),
		evidence: evidence(candidate),
		momentum: momentum(candidate),
		recency: recency(candidate, windowEnd),
	};
	const rankingScore = (
		scoreBreakdown.relevance * 0.3
		+ scoreBreakdown.impact * 0.25
		+ scoreBreakdown.evidence * 0.2
		+ scoreBreakdown.momentum * 0.15
		+ scoreBreakdown.recency * 0.1
	);
	return { ...candidate, rankingScore, scoreBreakdown };
}

function titleTokens(title: string): Set<string> {
	return new Set(title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/u).filter((token) => token.length > 2));
}

function titleSimilarity(left: string, right: string): number {
	const a = titleTokens(left);
	const b = titleTokens(right);
	const intersection = [...a].filter((token) => b.has(token)).length;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}

export function selectNewsCandidates(
	candidates: NewsCandidate[],
	windowEnd: Date,
	recentUrlHashes: Set<string>,
	urlHash: (url: string) => string,
): RankedNewsCandidate[] {
	const ranked = candidates
		.filter((candidate) => !recentUrlHashes.has(urlHash(candidate.canonicalUrl)) || candidate.severity === 'critical')
		.map((candidate) => rankCandidate(candidate, windowEnd))
		.filter((candidate) => (
			candidate.scoreBreakdown.relevance >= 55
			|| (candidate.official && candidate.severity !== 'normal')
		))
		.sort((left, right) => right.rankingScore - left.rankingScore);
	const officialMajorBrands = new Set(ranked
		.filter((candidate) => candidate.official && candidate.severity !== 'normal' && candidate.brand)
		.map((candidate) => candidate.brand));
	const selected: RankedNewsCandidate[] = [];
	for (const candidate of ranked) {
		const threeBrandPriority = officialMajorBrands.size >= 3
			&& candidate.official
			&& candidate.severity !== 'normal'
			&& Boolean(candidate.brand);
		const duplicate = selected.some((item) => {
			if (item.canonicalUrl === candidate.canonicalUrl) return true;
			const distinctPriorityBrands = threeBrandPriority
				&& item.official
				&& item.severity !== 'normal'
				&& item.brand !== candidate.brand;
			return !distinctPriorityBrands && titleSimilarity(item.title, candidate.title) >= 0.6;
		});
		if (duplicate) {
			continue;
		}
		const sameBrand = selected.filter((item) => item.brand && item.brand === candidate.brand).length;
		const sameCategory = selected.filter((item) => item.category === candidate.category).length;
		if (sameBrand >= 2 || (sameCategory >= 2 && !threeBrandPriority)) continue;
		selected.push(candidate);
		if (selected.length === 12) break;
	}
	return selected;
}
