import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { DiscordAdapter } from '../domain/adapters.js';
import type { AiNewsStore } from '../persistence/contracts.js';
import { AiNewsLlmService } from './llm-service.js';
import { selectNewsCandidates } from './ranking.js';
import type { AiNewsSummary, NewsSourceAdapter, RankedNewsCandidate } from './types.js';
import { newsUrlHash } from './url.js';

const categoryLabels: Record<RankedNewsCandidate['category'], string> = {
	newModel: '新模型',
	newTechnique: '新技術',
	newUsage: '新用法',
	productUpdate: '產品更新',
	securityIncident: '安全事件',
	serviceIncident: '服務事件',
	industryEvent: '產業事件',
};

function taipeiDateKey(value: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(value);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

function isWeekend(value: Date, timezone: string): boolean {
	const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(value);
	return weekday === 'Sat' || weekday === 'Sun';
}

function digestWindowStart(
	now: Date,
	lastPublishedAt: Date | null,
	initialLookbackHours: number,
	maxLookbackHours: number,
): Date {
	const lookbackHours = lastPublishedAt ? maxLookbackHours : initialLookbackHours;
	const earliest = new Date(now.getTime() - lookbackHours * 3_600_000);
	return lastPublishedAt && lastPublishedAt > earliest ? lastPublishedAt : earliest;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function renderDigest(
	dateKey: string,
	marker: string,
	items: Array<{ candidate: RankedNewsCandidate; summary: AiNewsSummary }>,
	preview: boolean,
): string {
	const title = `${preview ? '生成式 AI 早報測試' : '生成式 AI 早報'}｜${dateKey.replaceAll('-', '/')}`;
	const sections = items.map(({ candidate, summary }, index) => `${index + 1}. [${categoryLabels[candidate.category]}] ${truncate(summary.headline, 110)}
發生什麼事：${truncate(summary.whatHappened, 180)}
為什麼重要：${truncate(summary.whyImportant, 160)}
可以怎麼用：${truncate(summary.howToUse, 150)}
來源與原文：${candidate.canonicalUrl}`);
	const shortage = items.length < 3
		? `\n\n本期只有 ${items.length} 則具備足夠來源與重要性，未使用低品質內容湊數。`
		: '';
	const body = `${title}\n\n${sections.join('\n\n')}${shortage}`;
	const suffix = `\n\n-# ${marker}`;
	return `${truncate(body, 2_000 - suffix.length)}${suffix}`;
}

export interface AiNewsDigestOptions {
	timezone: string;
	initialLookbackHours: number;
	maxLookbackHours: number;
}

export class AiNewsDigestService {
	public constructor(
		private readonly store: AiNewsStore,
		private readonly discord: DiscordAdapter,
		private readonly sources: NewsSourceAdapter[],
		private readonly summaries: AiNewsLlmService,
		private readonly options: AiNewsDigestOptions,
		private readonly logger: Logger,
	) {}

	public async run(now = new Date(), guildId?: string, preview = false): Promise<void> {
		if (!preview && isWeekend(now, this.options.timezone)) {
			this.logger.info({ at: now.toISOString() }, 'AI news digest skipped on weekend');
			return;
		}
		const settings = guildId
			? [await this.store.findAiNewsSetting(guildId)].filter((item) => item?.enabled)
			: await this.store.listEnabledAiNewsSettings();
		for (const setting of settings) {
			if (setting) await this.runForSetting(setting, now, preview);
		}
	}

	private async runForSetting(
		setting: NonNullable<Awaited<ReturnType<AiNewsStore['findAiNewsSetting']>>>,
		now: Date,
		preview: boolean,
	): Promise<void> {
		const digestDate = taipeiDateKey(now, this.options.timezone);
		const lastPublishedAt = await this.store.findLastPublishedAiNewsDigestAt(setting.id);
		const windowStart = digestWindowStart(
			now,
			lastPublishedAt,
			this.options.initialLookbackHours,
			this.options.maxLookbackHours,
		);
		const traceId = randomUUID();
		const marker = `ai-news:${setting.id}:${digestDate}${preview ? ':preview' : ''}`;
		const digest = preview ? null : await this.store.claimAiNewsDigest({
			settingId: setting.id,
			digestDate,
			windowStart,
			windowEnd: now,
			traceId,
		});
		if (digest?.status === 'PUBLISHED') return;
		try {
			const results = await Promise.allSettled(this.sources.map(async (source) => source.listCandidates(windowStart, now)));
			const candidates = results.flatMap((result, index) => {
				if (result.status === 'fulfilled') return result.value;
				this.logger.warn({ source: this.sources[index]?.name, err: result.reason, traceId }, 'AI news source failed');
				return [];
			});
			if (results.every((result) => result.status === 'rejected')) throw new Error('所有 AI 新聞來源都無法使用');
			const recentHashes = await this.store.findRecentAiNewsUrlHashes(
				setting.discordGuildId,
				new Date(now.getTime() - 7 * 86_400_000),
			);
			const ranked = selectNewsCandidates(candidates, now, recentHashes, newsUrlHash);
			const summaries = await this.summaries.summarizeDigest(ranked, traceId);
			const byId = new Map(ranked.map((candidate) => [candidate.id, candidate]));
			const items = summaries.flatMap((summary) => {
				const candidate = byId.get(summary.candidateId);
				return candidate ? [{ candidate, summary }] : [];
			});
			const existingMessageId = await this.discord.findRecentChannelMessageByMarker?.(setting.discordChannelId, marker);
			const discordMessageId = existingMessageId ?? await this.discord.sendChannelMessage(
				setting.discordChannelId,
				renderDigest(digestDate, marker, items, preview),
			);
			if (digest) {
				await this.store.completeAiNewsDigest({
					digestId: digest.id,
					discordMessageId,
					publishedAt: now,
					items: items.map(({ candidate, summary }, index) => ({
						rank: index + 1,
						category: candidate.category,
						...(candidate.brand ? { brand: candidate.brand } : {}),
						title: candidate.title,
						canonicalUrl: candidate.canonicalUrl,
						urlHash: newsUrlHash(candidate.canonicalUrl),
						provider: candidate.provider,
						evidence: { urls: candidate.evidenceUrls, score: candidate.scoreBreakdown },
						summary,
					})),
				});
			}
			this.logger.info({ traceId, guildId: setting.discordGuildId, itemCount: items.length, preview }, 'AI news digest published');
		} catch (error) {
			if (digest) await this.store.failAiNewsDigest(digest.id, error instanceof Error ? error.message : '未知錯誤');
			throw error;
		}
	}
}

export const aiNewsDigestInternals = { digestWindowStart, isWeekend, taipeiDateKey };
