import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { GitHubInstallationChoice, GitHubRepositoryChoice } from '../domain/adapters.js';
import type { ProjectContext } from '../domain/models.js';

export type SetupRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

function mark(done: boolean): string {
  return done ? '✅' : '⬜';
}

function short(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function projectComplete(project: ProjectContext | undefined, peopleCount: number): boolean {
  return Boolean(project && project.repositories.length > 0 && project.summaryChannelId && peopleCount > 0);
}

export function setupWizardText(input: {
  projects: ProjectContext[];
  selectedProject?: ProjectContext;
  peopleCount: number;
	aiNewsChannelId?: string;
	aiNewsAvailable?: boolean;
}): string {
  const project = input.selectedProject;
  const checks = [
    input.projects.length > 0,
    Boolean(project && project.repositories.length > 0),
    Boolean(project?.summaryChannelId),
    input.peopleCount > 0,
  ];
  const completed = checks.filter(Boolean).length;
  const next = input.projects.length === 0
    ? '按「建立第一個專案」，選擇 Discord 專案頻道。'
    : !project
      ? '從上方選單選擇要設定的專案。'
      : project.repositories.length === 0
        ? '按「選擇 Repository」，直接勾選 GitHub Repo。'
        : !project.summaryChannelId
          ? '按「設定工作摘要」，選擇 #工作摘要。'
          : input.peopleCount === 0
            ? '按「綁定團隊成員」，選人並填寫 GitHub 帳號。'
            : '設定完成。可以按「測試 16:30 提醒」進行實機驗收。';

  const projectDetails = project
    ? `\n**目前專案：${project.name}**
- 專案討論：<#${project.discordChannelId}>
- Repository：${project.repositories.length > 0 ? project.repositories.map((repo) => `${repo.owner}/${repo.name}`).join('、') : '尚未設定'}
- 工作摘要：${project.summaryChannelId ? `<#${project.summaryChannelId}>` : '尚未設定'}
- 行程通知：${project.leaveChannelId ? `<#${project.leaveChannelId}>` : '選用，尚未設定'}`
    : '';

  const aiNews = input.aiNewsChannelId
		? `\n\n**AI 新聞：** <#${input.aiNewsChannelId}>（週一至週五 09:00）`
		: input.aiNewsAvailable
			? '\n\n**AI 新聞：** 尚未設定，可選擇團隊建立的 #AI新聞。'
			: '';

  return `🧭 **Bot 快速設定｜${completed}/4 完成**

${mark(checks[0] ?? false)} 1. 建立專案並連接 GitHub App
${mark(checks[1] ?? false)} 2. 選擇 GitHub Repository
${mark(checks[2] ?? false)} 3. 設定每日工作摘要頻道
${mark(checks[3] ?? false)} 4. 綁定至少一位團隊成員

➡️ **下一步：${next}**${projectDetails}${aiNews}

${projectComplete(project, input.peopleCount)
    ? '🟢 已可日常使用：成員只需在 16:30 討論串補充一兩句。'
    : '所有設定都只會回覆給你，不會洗版頻道。'}`;
}

export function setupWizardRows(input: {
  projects: ProjectContext[];
  selectedProject?: ProjectContext;
  peopleCount: number;
	aiNewsChannelId?: string;
	aiNewsAvailable?: boolean;
}): SetupRow[] {
  const rows: SetupRow[] = [];
  const selected = input.selectedProject;
  if (input.projects.length > 1) {
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('setup-project-select')
        .setPlaceholder('選擇要設定的專案')
        .addOptions(input.projects.slice(0, 25).map((project) => ({
          label: short(project.name, 100),
          description: short(`${project.repositories.length} 個 Repo｜專案頻道 #${project.discordChannelId}`, 100),
          value: project.bindingId,
          default: project.bindingId === selected?.bindingId,
        }))),
    ));
  }

  rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup:project:new').setLabel('建立新專案').setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`setup:health:${selected?.bindingId ?? 'root'}`)
      .setLabel('執行健康檢查')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!selected),
    new ButtonBuilder()
      .setCustomId(`setup:refresh:${selected?.bindingId ?? 'root'}`)
      .setLabel('重新整理')
      .setStyle(ButtonStyle.Secondary),
  ));

  rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup:repository:${selected?.bindingId ?? 'root'}`)
      .setLabel('選擇 Repository')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!selected),
    new ButtonBuilder()
      .setCustomId(`setup:summary:${selected?.bindingId ?? 'root'}`)
      .setLabel('設定工作摘要')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!selected),
    new ButtonBuilder()
      .setCustomId(`setup:leave:${selected?.bindingId ?? 'root'}`)
      .setLabel('設定行程通知')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!selected),
    new ButtonBuilder()
      .setCustomId(`setup:member:${selected?.bindingId ?? 'root'}`)
      .setLabel('綁定團隊成員')
      .setStyle(ButtonStyle.Secondary),
  ));

  const ready = projectComplete(selected, input.peopleCount);
  rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup:report-open:${selected?.bindingId ?? 'root'}`)
      .setLabel('測試 16:30 提醒')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!ready),
    new ButtonBuilder()
      .setCustomId(`setup:report-summary:${selected?.bindingId ?? 'root'}`)
      .setLabel('測試 17:00 彙整')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!ready),
    new ButtonBuilder().setCustomId('setup:help:root').setLabel('一般成員怎麼用').setStyle(ButtonStyle.Secondary),
  ));
	if (input.aiNewsAvailable) {
		rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('setup:ai-news:root')
				.setLabel('設定 AI 新聞')
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId('setup:ai-news-preview:root')
				.setLabel('測試今日新聞')
				.setStyle(ButtonStyle.Primary)
				.setDisabled(!input.aiNewsChannelId),
		));
	}
  return rows;
}

export function projectChannelPicker(): SetupRow[] {
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup-project-channel')
      .setPlaceholder('選擇日常討論的專案頻道')
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText),
  )];
}

export function installationPicker(channelId: string, installations: GitHubInstallationChoice[]): SetupRow[] {
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup-project-installation:${channelId}`)
      .setPlaceholder('選擇 GitHub App 安裝帳號')
      .addOptions(installations.slice(0, 25).map((installation) => ({
        label: short(installation.accountLogin, 100),
        description: `${installation.accountType === 'Organization' ? '組織' : '個人'}｜${installation.repositorySelection === 'all' ? '所有 Repo' : '指定 Repo'}`,
        value: installation.id,
      }))),
  )];
}

export function projectDetailsModal(input: {
  channelId: string;
  channelName: string;
  installationId: string;
  accountLogin: string;
}): ModalBuilder {
  const name = new TextInputBuilder()
    .setCustomId('project-name')
    .setPlaceholder('例如：CUBI')
    .setValue(short(input.channelName, 100))
    .setRequired(true)
    .setMaxLength(100)
    .setStyle(TextInputStyle.Short);
  const projectId = new TextInputBuilder()
    .setCustomId('project-id')
    .setPlaceholder('沒有使用 GitHub Project 就留空')
    .setRequired(false)
    .setMaxLength(100)
    .setStyle(TextInputStyle.Short);
  return new ModalBuilder()
    .setCustomId(`setup-project-modal:${input.channelId}:${input.installationId}`)
    .setTitle(`連接 ${short(input.accountLogin, 34)}`)
    .addLabelComponents(
      new LabelBuilder().setLabel('專案顯示名稱').setTextInputComponent(name),
      new LabelBuilder().setLabel('GitHub Project V2 ID（選填）').setTextInputComponent(projectId),
    );
}

export function setupChannelPicker(projectId: string, kind: 'summary' | 'leave'): SetupRow[] {
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`setup-channel-${kind}:${projectId}`)
      .setPlaceholder(kind === 'summary' ? '選擇 #工作摘要' : '選擇 #行程通知')
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText),
  )];
}

export function aiNewsChannelPicker(): SetupRow[] {
	return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId('setup-ai-news-channel')
			.setPlaceholder('選擇 #AI新聞')
			.setMinValues(1)
			.setMaxValues(1)
			.addChannelTypes(ChannelType.GuildText),
	)];
}

export function memberPicker(projectId: string): SetupRow[] {
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`setup-member:${projectId}`)
      .setPlaceholder('選擇要綁定的 Discord 成員')
      .setMinValues(1)
      .setMaxValues(1),
  )];
}

export function memberLoginModal(userId: string, projectId: string, suggestedLogin: string): ModalBuilder {
  const login = new TextInputBuilder()
    .setCustomId('github-login')
    .setPlaceholder('例如：octocat')
    .setValue(short(suggestedLogin, 100))
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(100)
    .setStyle(TextInputStyle.Short);
  return new ModalBuilder()
    .setCustomId(`setup-member-modal:${userId}:${projectId}`)
    .setTitle('綁定 GitHub 帳號')
    .addLabelComponents(
      new LabelBuilder().setLabel('這位成員的 GitHub 帳號').setTextInputComponent(login),
    );
}

export function repositoryInstallationPicker(
  projectId: string,
  installations: GitHubInstallationChoice[],
  defaultInstallationId: string,
): SetupRow[] {
  const ordered = [...installations].sort((left, right) => (
    left.id === defaultInstallationId ? -1 : right.id === defaultInstallationId ? 1 : 0
  ));
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup-repo-installation:${projectId}`)
      .setPlaceholder('這些 Repo 屬於哪個 GitHub 帳號？')
      .addOptions(ordered.slice(0, 25).map((installation) => ({
        label: short(installation.accountLogin, 100),
        description: installation.id === defaultInstallationId ? '目前專案的預設帳號' : '另一個已安裝 App 的帳號',
        value: installation.id,
      }))),
  )];
}

export function repositoryPickerRows(input: {
  projectId: string;
  installationId: string;
  repositories: GitHubRepositoryChoice[];
  page: number;
}): SetupRow[] {
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(input.repositories.length / pageSize));
  const page = Math.min(Math.max(input.page, 0), pageCount - 1);
  const pageRepositories = input.repositories.slice(page * pageSize, (page + 1) * pageSize);
  if (pageRepositories.length === 0) return [];
  const rows: SetupRow[] = [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`setup-repositories:${input.projectId}:${input.installationId}:${page}`)
      .setPlaceholder('可一次勾選多個 Repository')
      .setMinValues(1)
      .setMaxValues(pageRepositories.length)
      .addOptions(pageRepositories.map((repository) => ({
        label: short(repository.fullName, 100),
        description: repository.private ? 'Private repository' : 'Public repository',
        value: repository.id,
      }))),
  )];
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`setup:repo-page:${input.projectId}:${input.installationId}:${page - 1}`)
        .setLabel('上一頁')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`setup:repo-page:${input.projectId}:${input.installationId}:${page + 1}`)
        .setLabel('下一頁')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    ));
  }
  return rows;
}
