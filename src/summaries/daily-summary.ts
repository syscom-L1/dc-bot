import type { DiscordAdapter, GitHubAdapter } from '../domain/adapters.js';
import type { ProjectContext, WorkItem } from '../domain/models.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';
import { evaluateWorkItemRisks, type RiskRules } from '../github/rules.js';

interface SummaryGroup {
  title: string;
  items: WorkItem[];
}

function formatDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function itemLine(item: WorkItem): string {
  const owner = item.assignees.length > 0 ? item.assignees.map((login) => `@${login}`).join(', ') : '無人負責';
  const target = item.targetDate ? `｜期限 ${item.targetDate.toISOString().slice(0, 10)}` : '';
  const prefix = item.type === 'pull_request' ? 'PR' : '#';
  return `- [${prefix}${item.number} ${item.title}](<${item.url}>)｜${owner}${target}`;
}

export function renderDailySummary(
  project: ProjectContext,
  items: WorkItem[],
  now: Date,
  timezone: string,
  riskRules: RiskRules,
): string[] {
  const done = items.filter((item) => item.state !== 'open');
  const inProgress = items.filter((item) => item.state === 'open' && item.status === project.config.statusOptions.inProgress);
  const review = items.filter((item) => item.state === 'open' && (
    item.status === project.config.statusOptions.review || item.type === 'pull_request'
  ));
  const blocked = items.filter((item) => item.state === 'open' && item.status === project.config.statusOptions.blocked);
  const ciFailures = items.filter((item) => item.state === 'open' && item.workflowState === 'failure');
  const unassigned = items.filter((item) => item.state === 'open' && item.assignees.length === 0);
  const dueSoon = items.filter((item) => evaluateWorkItemRisks(item, now, riskRules).some((risk) => risk.type === 'due_soon_inactive'));
  const overdue = items.filter((item) => evaluateWorkItemRisks(item, now, riskRules).some((risk) => risk.type === 'overdue'));

  const groups: SummaryGroup[] = [
    { title: '✅ 今日完成／已完成', items: done },
    { title: '🚧 進行中', items: inProgress },
    { title: '👀 等待 Review', items: review },
    { title: '🧪 CI 失敗', items: ciFailures },
    { title: '⚠️ 即將到期且缺少活動', items: dueSoon },
    { title: '⏰ 已逾期', items: overdue },
    { title: '⛔ 阻塞', items: blocked },
    { title: '👤 無人負責', items: unassigned },
  ];

  const sections = groups
    .filter((group) => group.items.length > 0)
    .map((group) => {
      const visible = group.items.slice(0, 12).map(itemLine);
      if (group.items.length > visible.length) visible.push(`- 另有 ${group.items.length - visible.length} 項，請至 GitHub Project 查看`);
      return `${group.title}\n${visible.join('\n')}`;
    });

  const header = `📅 ${formatDate(now, timezone)} 每日工作摘要\n\n【${project.name}】`;
  const content = sections.length > 0 ? `${header}\n\n${sections.join('\n\n')}` : `${header}\n\n今天沒有需要摘要的 GitHub 工作項目。`;
  return splitDiscordMessage(content);
}

export function splitDiscordMessage(content: string, limit = 1_900): string[] {
  if (content.length <= limit) return [content];
  const chunks: string[] = [];
  let current = '';
  for (const block of content.split('\n\n')) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = block;
    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class DailySummaryService {
  public constructor(
    private readonly bindings: ProjectBindingStore,
    private readonly github: GitHubAdapter,
    private readonly discord: DiscordAdapter,
    private readonly timezone: string,
    private readonly rules: RiskRules,
  ) {}

  public async run(now = new Date()): Promise<number> {
    let sent = 0;
    for (const project of await this.bindings.listActive()) {
      if (!project.summaryChannelId) continue;
      const items = await this.github.listWorkItems(project);
      for (const message of renderDailySummary(project, items, now, this.timezone, this.rules)) {
        await this.discord.sendChannelMessage(project.summaryChannelId, message);
        sent += 1;
      }
    }
    return sent;
  }
}
