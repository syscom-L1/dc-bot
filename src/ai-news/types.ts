export const aiNewsCategories = [
	'newModel',
	'newTechnique',
	'newUsage',
	'productUpdate',
	'securityIncident',
	'serviceIncident',
	'industryEvent',
] as const;

export type AiNewsCategory = typeof aiNewsCategories[number];
export type AiNewsSeverity = 'normal' | 'major' | 'critical';

export interface NewsEngagement {
	score?: number;
	comments?: number;
	likes?: number;
	downloads?: number;
}

export interface NewsCandidate {
	id: string;
	provider: string;
	category: AiNewsCategory;
	brand?: 'OpenAI' | 'Anthropic' | 'Hugging Face';
	official: boolean;
	severity: AiNewsSeverity;
	title: string;
	publishedAt: Date;
	canonicalUrl: string;
	sourceUrl: string;
	engagement: NewsEngagement;
	evidenceUrls: string[];
	sourceSummary: string;
}

export interface NewsSourceAdapter {
	readonly name: string;
	listCandidates(windowStart: Date, windowEnd: Date): Promise<NewsCandidate[]>;
}

export interface RankedNewsCandidate extends NewsCandidate {
	rankingScore: number;
	scoreBreakdown: {
		relevance: number;
		impact: number;
		evidence: number;
		momentum: number;
		recency: number;
	};
}

export interface AiNewsSummary {
	candidateId: string;
	headline: string;
	whatHappened: string;
	whyImportant: string;
	howToUse: string;
}

export interface MemberLinkSummary {
	candidateId: string;
	title: string;
	category: AiNewsCategory;
	summary: string;
	whyImportant: string;
	howToUse: string;
}

export interface FetchedArticle {
	canonicalUrl: string;
	title: string;
	description: string;
	text: string;
	publishedAt?: Date;
	contentType: string;
}
