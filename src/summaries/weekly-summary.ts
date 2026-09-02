import type { DiscordAdapter, GitHubAdapter } from '../domain/adapters.js';
import type { ProjectContext, WorkItem } from '../domain/models.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';
import { splitDiscordMessage } from './daily-summary.js';
import {
	renderCommitHistorySummary,
	weeklyCommitWindow,
	type CommitHistorySummaryService,
} from './commit-history-summary.js';

const taipeiOffsetMs = 8 * 60 * 60 * 1_000;

function weekBounds(now: Date): { start: Date; end: Date; nextEnd: Date } {
  const local = new Date(now.getTime() + taipeiOffsetMs);
  const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  const start = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - weekday + 1,
    -8,
  ));
  return {
    start,
    end: new Date(start.getTime() + 7 * 86_400_000),
    nextEnd: new Date(start.getTime() + 14 * 86_400_000),
  };
}

function inRange(value: Date | undefined, start: Date, end: Date): boolean {
  return Boolean(value && value >= start && value < end);
}

function itemLine(item: WorkItem): string {
  const prefix = item.type === 'pull_request' ? 'PR' : '#';
  const assignees = item.assignees.length > 0 ? item.assignees.map((login) => `@${login}`).join(', ') : '無人負責';
  return `- [${prefix}${item.number} ${item.title}](<${item.url}>)｜${assignees}${item.targetDate ? `｜期限 ${item.targetDate.toISOString().slice(0, 10)}` : ''}`;
}

function section(title: string, items: WorkItem[]): string {
  if (items.length === 0) return `${title}\n- 無`;
  const visible = items.slice(0, 15).map(itemLine);
  if (items.length > visible.length) visible.push(`- 另有 ${items.length - visible.length} 項，請至 GitHub Project 查看`);
  return `${title}\n${visible.join('\n')}`;
}

export function renderWeeklySummary(
  project: ProjectContext,
  items: WorkItem[],
  now: Date,
  inactivityHours: number,
): string[] {
  const bounds = weekBounds(now);
  const planned = items.filter((item) => inRange(item.startDate ?? item.targetDate, bounds.start, bounds.end));
  const completed = items.filter((item) => item.state !== 'open' && inRange(item.updatedAt, bounds.start, bounds.end));
  const carried = items.filter((item) => item.state === 'open' && Boolean(item.targetDate && item.targetDate < bounds.end));
  const overdue = items.filter((item) => item.state === 'open' && Boolean(item.targetDate && item.targetDate < now));
  const blocked = items.filter((item) => item.state === 'open' && item.status === project.config.statusOptions.blocked);
  const reviewWaiting = items.filter((item) => item.state === 'open' && item.type === 'pull_request' && item.reviewState === 'pending');
  const ciFailures = items.filter((item) => item.state === 'open' && item.workflowState === 'failure');
  const nextWeek = items.filter((item) => inRange(item.startDate ?? item.targetDate, bounds.end, bounds.nextEnd));
  const missing = items.filter((item) => (
    item.state === 'open'
    && now.getTime() - item.updatedAt.getTime() >= inactivityHours * 3_600_000
  ));

  const content = `📊 每週工作摘要\n\n【${project.name}】

${section('📋 本週預定工作', planned)}

${section('✅ 本週完成', completed)}

${section('↪️ 未完成並移至下週', carried)}

${section('⏰ 已逾期', overdue)}

${section('⛔ 阻塞事項', blocked)}

${section('👀 等待 Review 過久', reviewWaiting)}

${section('🧪 CI 失敗', ciFailures)}

${section('🗓️ 下週已排定工作', nextWeek)}

${section('❓ 缺少進度資訊', missing)}`;
  return splitDiscordMessage(content);
}

export class WeeklySummaryService {
  public constructor(
    private readonly bindings: ProjectBindingStore,
    private readonly github: GitHubAdapter,
    private readonly discord: DiscordAdapter,
    private readonly inactivityHours: number,
		private readonly commitHistory?: CommitHistorySummaryService,
  ) {}

  public async run(now = new Date()): Promise<number> {
    let sent = 0;
    for (const project of await this.bindings.listActive()) {
      if (!project.summaryChannelId) continue;
      const items = await this.github.listWorkItems(project);
      for (const content of renderWeeklySummary(project, items, now, this.inactivityHours)) {
        await this.discord.sendChannelMessage(project.summaryChannelId, content);
        sent += 1;
      }
			if (this.commitHistory) {
				const commitSummary = await this.commitHistory.summarize(project, weeklyCommitWindow(now));
				for (const content of renderCommitHistorySummary(commitSummary)) {
					await this.discord.sendChannelMessage(project.summaryChannelId, content);
					sent += 1;
				}
			}
    }
    return sent;
  }
}
