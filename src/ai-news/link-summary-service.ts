import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { DiscordAdapter } from '../domain/adapters.js';
import type { AiNewsStore } from '../persistence/contracts.js';
import { AiNewsLlmService, memberLinkSummarySchema } from './llm-service.js';
import { SafeUrlFetcher } from './safe-url-fetcher.js';
import type { MemberLinkSummary } from './types.js';
import { candidateId, newsUrlHash } from './url.js';

const categoryLabels: Record<MemberLinkSummary['category'], string> = {
	newModel: '新模型',
	newTechnique: '新技術',
	newUsage: '新用法',
	productUpdate: '產品更新',
	securityIncident: '安全事件',
	serviceIncident: '服務事件',
	industryEvent: '產業事件',
};

export interface AiNewsLinkSummaryJob {
	guildId: string;
	channelId: string;
	messageId: string;
	userId: string;
	urls: string[];
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function render(
	marker: string,
	items: Array<{ url: string; summary: MemberLinkSummary }>,
	failures: Array<{ url: string; reason: string }>,
): string {
	const sections = items.map(({ url, summary }, index) => `${index + 1}. [${categoryLabels[summary.category]}] ${truncate(summary.title, 110)}
主要內容：${truncate(summary.summary, 220)}
為什麼值得關注：${truncate(summary.whyImportant, 160)}
可能的實際應用：${truncate(summary.howToUse, 150)}
原始來源：${url}`);
	const errors = failures.map(({ url, reason }) => `無法可靠摘要：${url}\n原因：${truncate(reason, 160)}`);
	const body = `AI 新聞連結摘要\n\n${[...sections, ...errors].join('\n\n')}`;
	const suffix = `\n\n-# ${marker}`;
	return `${truncate(body, 2_000 - suffix.length)}${suffix}`;
}

export class AiNewsLinkSummaryService {
	public constructor(
		private readonly store: AiNewsStore,
		private readonly discord: DiscordAdapter,
		private readonly fetcher: SafeUrlFetcher,
		private readonly summaries: AiNewsLlmService,
		private readonly logger: Logger,
	) {}

	public async run(job: AiNewsLinkSummaryJob, now = new Date()): Promise<void> {
		if (!this.discord.replyToMessage) throw new Error('Discord adapter does not support message replies');
		const setting = await this.store.findAiNewsSetting(job.guildId);
		if (!setting?.enabled || setting.discordChannelId !== job.channelId) return;
		const records = await Promise.all(job.urls.map(async (url) => this.store.claimAiNewsLinkSummary({
			discordGuildId: job.guildId,
			discordChannelId: job.channelId,
			discordMessageId: job.messageId,
			discordUserId: job.userId,
			canonicalUrl: url,
			urlHash: newsUrlHash(url),
		})));
		if (records.length > 0 && records.every((record) => record.status === 'COMPLETED' && record.replyMessageId)) return;

		const traceId = randomUUID();
		const cacheSince = new Date(now.getTime() - 7 * 86_400_000);
		const completed: Array<{ recordId: string; url: string; summary: MemberLinkSummary }> = [];
		const toSummarize: Array<{
			recordId: string;
			url: string;
			id: string;
			article: Awaited<ReturnType<SafeUrlFetcher['fetchArticle']>>;
		}> = [];
		const failures: Array<{ recordId: string; url: string; reason: string }> = [];
		for (const record of records) {
			const cached = await this.store.findRecentAiNewsLinkSummary(record.urlHash, cacheSince);
			const cachedSummary = memberLinkSummarySchema.safeParse(cached?.summary);
			if (cachedSummary.success) {
				completed.push({ recordId: record.id, url: record.canonicalUrl, summary: cachedSummary.data });
				continue;
			}
			try {
				const article = await this.fetcher.fetchArticle(record.canonicalUrl);
				toSummarize.push({
					recordId: record.id,
					url: record.canonicalUrl,
					id: candidateId('member-link', record.canonicalUrl),
					article,
				});
			} catch (error) {
				failures.push({
					recordId: record.id,
					url: record.canonicalUrl,
					reason: error instanceof Error ? error.message : '無法讀取來源',
				});
			}
		}

		const generated = await this.summaries.summarizeMemberLinks(
			toSummarize.map(({ id, article }) => ({ id, article })),
			traceId,
		);
		const generatedById = new Map(generated.map((summary) => [summary.candidateId, summary]));
		for (const item of toSummarize) {
			const summary = generatedById.get(item.id);
			if (summary) completed.push({ recordId: item.recordId, url: item.url, summary });
		}

		const marker = `ai-news-link:${job.messageId}`;
		const existingReplyId = await this.discord.findRecentChannelMessageByMarker?.(job.channelId, marker);
		const replyMessageId = existingReplyId ?? await this.discord.replyToMessage(
			job.channelId,
			job.messageId,
			render(marker, completed, failures),
		);
		await Promise.all([
			...completed.map(async (item) => this.store.completeAiNewsLinkSummary({
				id: item.recordId,
				summary: item.summary,
				replyMessageId,
				completedAt: now,
			})),
			...failures.map(async (item) => this.store.failAiNewsLinkSummary(item.recordId, item.reason)),
		]);
		this.logger.info({ traceId, messageId: job.messageId, completed: completed.length, failed: failures.length }, 'AI news member links summarized');
	}
}
