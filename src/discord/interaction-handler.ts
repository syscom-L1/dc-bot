import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { ConflictError, discordErrorMessage, ForbiddenError, NotFoundError, ValidationError } from '../common/errors.js';
import type { GitHubRepositoryChoice, GitHubSetupAdapter, QueueAdapter } from '../domain/adapters.js';
import type { ProjectContext } from '../domain/models.js';
import type { AiNewsStore, AuditStore, PersonStore, ProjectBindingStore } from '../persistence/contracts.js';
import type { DocumentBindingStore } from '../google/document-service.js';
import type { ProgressProposalService } from '../reminders/reminder-service.js';
import type { DiscordAccessPolicy } from './access-policy.js';
import { botHelpText, guildStatusText, setupGuidance, setupPanelRows, setupPanelText } from './help-content.js';
import {
  installationPicker,
  aiNewsChannelPicker,
  memberLoginModal,
  memberPicker,
  projectChannelPicker,
  projectDetailsModal,
  repositoryInstallationPicker,
  repositoryPickerRows,
  setupChannelPicker,
  setupWizardRows,
  setupWizardText,
} from './setup-wizard.js';

function memberRoleIds(interaction: Interaction): string[] {
  const member = interaction.member as GuildMember | null;
  return member ? [...member.roles.cache.keys()] : [];
}

function selectedValue(values: readonly string[], label: string): string {
  const value = values[0];
  if (!value) throw new Error(`請選擇${label}`);
  return value;
}

export class DiscordInteractionHandler {
  public constructor(
    private readonly policy: DiscordAccessPolicy,
    private readonly people: PersonStore,
    private readonly bindings: ProjectBindingStore,
    private readonly documents: DocumentBindingStore,
    private readonly audit: AuditStore,
    private readonly proposals: ProgressProposalService,
    private readonly github: GitHubSetupAdapter,
    private readonly queues: QueueAdapter,
    private readonly logger: Logger,
    private readonly timezone: string,
		private readonly commitHistoryEnabled = false,
    private readonly aiNews?: { store: AiNewsStore; enabled: boolean },
  ) {}

  public register(client: Client): void {
    client.on('interactionCreate', (interaction) => {
      void this.handle(interaction).catch(async (error: unknown) => {
        this.logger.error({ err: error, interactionId: interaction.id }, 'Discord interaction failed');
        const fallback = interaction.isMessageComponent() || interaction.isModalSubmit()
          ? '操作失敗，設定沒有被變更。請重新執行 `/bot setup` 後再試。'
          : '操作失敗，請稍後再試或聯絡管理員。';
        const message = discordErrorMessage(error, fallback);
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, ephemeral: true });
          else await interaction.reply({ content: message, ephemeral: true });
        }
      });
    });
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
      return;
    }
    if (interaction.isButton()) {
      await this.handleButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      await this.handleStringSelect(interaction);
      return;
    }
    if (interaction.isChannelSelectMenu()) {
      await this.handleChannelSelect(interaction);
      return;
    }
    if (interaction.isUserSelectMenu()) {
      await this.handleUserSelect(interaction);
      return;
    }
    if (interaction.isModalSubmit()) await this.handleModal(interaction);
  }

  private isAdmin(interaction: Interaction): boolean {
    return this.policy.isAdmin({
      guildId: interaction.guildId,
      channelId: interaction.channelId ?? '',
      roleIds: memberRoleIds(interaction),
    });
  }

  private requireAdmin(interaction: Interaction): void {
    if (!this.isAdmin(interaction)) {
      throw new ForbiddenError('此設定只能在 #bot設定 操作，或由具有 Bot 管理員 Role 的成員操作。');
    }
  }

  private requireGuild(interaction: Interaction): string {
    if (!interaction.guildId || !this.policy.isGuildAllowed(interaction.guildId)) {
      throw new ForbiddenError('此 Discord 伺服器尚未授權使用 Bot。');
    }
    return interaction.guildId;
  }

  private async projectForAction(projectId: string, guildId: string, channelId: string): Promise<ProjectContext> {
    if (projectId !== 'root') {
      const project = await this.bindings.findProjectById(projectId);
      if (project?.discordGuildId === guildId) return project;
      throw new NotFoundError('找不到這個專案，請重新執行 `/bot setup`。');
    }
    const current = await this.bindings.findByDiscordChannel(guildId, channelId);
    if (current) return current;
    const projects = await this.bindings.listByGuild(guildId);
    if (projects.length === 1 && projects[0]) return projects[0];
    throw new NotFoundError('請先在 `/bot setup` 選擇一個專案。');
  }

  private async setupPayload(guildId: string, channelId: string, selectedProjectId?: string) {
    const [projects, people, aiNewsSetting] = await Promise.all([
      this.bindings.listByGuild(guildId),
      this.people.listEnabled(),
      this.aiNews?.store.findAiNewsSetting(guildId),
    ]);
    const selectedProject = selectedProjectId && selectedProjectId !== 'root'
      ? projects.find((project) => project.bindingId === selectedProjectId)
      : projects.find((project) => project.discordChannelId === channelId) ?? (projects.length === 1 ? projects[0] : undefined);
    const input = {
			projects,
			peopleCount: people.length,
			...(selectedProject ? { selectedProject } : {}),
			...(aiNewsSetting?.enabled ? { aiNewsChannelId: aiNewsSetting.discordChannelId } : {}),
			aiNewsAvailable: this.aiNews?.enabled ?? false,
		};
    return { content: setupWizardText(input), components: setupWizardRows(input) };
  }

  private async linkPerson(input: {
    actorId: string;
    requestId: string;
    userId: string;
    displayName: string;
    githubLogin: string;
  }): Promise<void> {
    const githubLogin = input.githubLogin.trim().replace(/^@/u, '');
    if (!/^[\dA-Za-z](?:[\dA-Za-z-]{0,37}[\dA-Za-z])?$/u.test(githubLogin)) {
      throw new ValidationError('GitHub 帳號格式不正確，請只填帳號名稱，不要貼網址。');
    }
    const existing = await this.people.findByGithubLogin(githubLogin);
    if (existing && existing.discordUserId !== input.userId) {
      throw new ConflictError('GitHub @' + githubLogin + ' 已綁定其他 Discord 成員，請先由管理員確認帳號。');
    }
    const person = await this.people.link({
      displayName: input.displayName,
      discordUserId: input.userId,
      githubLogin,
      timezone: this.timezone,
    });
    await this.audit.append({
      actorType: 'discord_user', actorId: input.actorId, action: 'binding.person.upsert',
      resourceType: 'person', resourceId: person.id,
      after: { discordUserId: input.userId, githubLogin }, requestId: input.requestId,
    });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== 'bot') return;
    const guildId = this.requireGuild(interaction);
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'help') {
      await interaction.reply({ content: botHelpText(), ephemeral: true });
      return;
    }
    this.requireAdmin(interaction);
    if (subcommand === 'setup') {
      await interaction.reply({ ...(await this.setupPayload(guildId, interaction.channelId)), ephemeral: true });
      return;
    }
    if (subcommand === 'panel') {
      await interaction.reply({ content: setupPanelText(), components: setupPanelRows() });
      return;
    }
    if (subcommand === 'status') {
      const current = await this.bindings.findByDiscordChannel(guildId, interaction.channelId);
      const projects = current ? [current] : await this.bindings.listByGuild(guildId);
      await interaction.reply({ content: guildStatusText(projects), ephemeral: true });
      return;
    }
    if (subcommand === 'user-link') {
      const user = interaction.options.getUser('user', true);
      const githubLogin = interaction.options.getString('github-login', true);
      await this.linkPerson({
        actorId: interaction.user.id,
        requestId: interaction.id,
        userId: user.id,
        displayName: user.globalName ?? user.username,
        githubLogin,
      });
      await interaction.reply({ content: `✅ 已綁定 <@${user.id}> ↔ GitHub @${githubLogin.replace(/^@/u, '')}。`, ephemeral: true });
      return;
    }
    if (subcommand === 'bind-project') {
      const optionalProjectId = interaction.options.getString('project-id');
      const input = {
        name: interaction.options.getString('name', true),
        discordGuildId: guildId,
        discordChannelId: interaction.channelId,
        githubOrganization: interaction.options.getString('organization', true),
        githubInstallationId: interaction.options.getString('installation-id', true),
        ...(optionalProjectId ? { githubProjectId: optionalProjectId } : {}),
      };
      const project = await this.bindings.bindProject(input);
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.project.create',
        resourceType: 'project_binding', resourceId: project.bindingId,
        after: { name: project.name, githubProjectId: project.githubProjectId ?? null }, requestId: interaction.id,
      });
      await interaction.reply({ content: `✅ 已建立專案「${project.name}」。建議接著執行 /bot setup。`, ephemeral: true });
      return;
    }
    const project = await this.bindings.findByDiscordChannel(guildId, interaction.channelId);
    if (!project) throw new NotFoundError('目前頻道尚未綁定專案，請改用 `/bot setup` 建立。');
    if (subcommand === 'bind-repository') {
      const repositoryId = interaction.options.getString('repository-id');
      const repositoryInstallationId = interaction.options.getString('installation-id');
      const owner = interaction.options.getString('owner', true);
      const repository = interaction.options.getString('repository', true);
      await this.bindings.bindRepository({
        projectBindingId: project.bindingId,
        owner,
        name: repository,
        ...(repositoryId ? { githubRepositoryId: repositoryId } : {}),
        ...(repositoryInstallationId ? { githubInstallationId: repositoryInstallationId } : {}),
      });
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.repository.upsert',
        resourceType: 'project_binding', resourceId: project.bindingId,
        after: {
          owner, repository, repositoryId: repositoryId ?? null,
          installationId: repositoryInstallationId ?? project.githubInstallationId,
        }, requestId: interaction.id,
      });
      await interaction.reply({
        content: `✅ Repository 已綁定：${owner}/${repository}\nGitHub App 安裝：${repositoryInstallationId ?? '沿用專案預設'}`,
        ephemeral: true,
      });
      return;
    }
    if (subcommand === 'bind-summary-channel') {
      const channel = interaction.options.getChannel('channel', true);
      await this.bindings.setSummaryChannel(project.bindingId, channel.id);
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.summary_channel.update',
        resourceType: 'project_binding', resourceId: project.bindingId,
        after: { channelId: channel.id }, requestId: interaction.id,
      });
      await interaction.reply({ content: `✅ 工作摘要頻道已設為 <#${channel.id}>。`, ephemeral: true });
      return;
    }
    if (subcommand === 'bind-leave-channel') {
      const channel = interaction.options.getChannel('channel', true);
      await this.bindings.setLeaveChannel(project.bindingId, channel.id);
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.leave_channel.update',
        resourceType: 'project_binding', resourceId: project.bindingId,
        after: { channelId: channel.id }, requestId: interaction.id,
      });
      await interaction.reply({ content: `✅ 行程通知頻道已設為 <#${channel.id}>。`, ephemeral: true });
      return;
    }
    if (subcommand === 'bind-document') {
      const url = interaction.options.getString('url', true);
      const parts = new URL(url).pathname.split('/');
      const markerIndex = parts.indexOf('d');
      const documentId = markerIndex >= 0 ? parts[markerIndex + 1] : undefined;
      if (!documentId) throw new ValidationError('Google Docs URL 無效，請貼完整的 docs.google.com/document/d/... 網址。');
      const operations = interaction.options.getString('operations', true).split(',').map((value) => value.trim()).filter(Boolean);
      if (operations.length === 0 || operations.some((value) => !['comment', 'insert', 'replace'].includes(value))) {
        throw new ValidationError('operations 只能使用 comment,insert,replace');
      }
      const document = await this.documents.bind({
        projectBindingId: project.bindingId,
        documentId,
        documentUrl: url,
        displayName: interaction.options.getString('name', true),
        allowedOperations: operations,
      });
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.document.upsert',
        resourceType: 'document_binding', resourceId: document.id,
        after: { documentId, allowedOperations: operations }, requestId: interaction.id,
      });
      await interaction.reply({ content: '✅ Google 文件已加入專案允許清單。', ephemeral: true });
      return;
    }
    await interaction.reply({ content: guildStatusText([project]), ephemeral: true });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith('setup:')) {
      await this.handleSetupButton(interaction);
      return;
    }
    const [scope, action, id] = interaction.customId.split(':');
    if (!scope || !action || !id) return;
    if (scope === 'progress' && action === 'still') {
      const proposal = await this.proposals.proposeStillWorking(id, interaction.user.id);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`proposal:confirm:${proposal.proposalId}`).setLabel('確認').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`proposal:cancel:${proposal.proposalId}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: proposal.preview, components: [row], ephemeral: true });
      return;
    }
    if (scope === 'progress' && action === 'snooze') {
      await this.proposals.snooze(id, interaction.user.id);
      await interaction.reply({ content: '已暫停提醒 24 小時。', ephemeral: true });
      return;
    }
    if (scope === 'proposal' && action === 'confirm') {
      await interaction.deferReply({ ephemeral: true });
      const url = await this.proposals.execute(id, interaction.user.id, randomUUID());
      await interaction.editReply(`GitHub 已更新並寫入稽核紀錄：${url}`);
      return;
    }
    if (scope === 'proposal' && action === 'cancel') {
      await this.proposals.reject(id, interaction.user.id);
      await interaction.reply({ content: '已取消，GitHub 未被修改。', ephemeral: true });
    }
  }

  private async handleSetupButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    const action = parts[1] ?? '';
    if (action === 'help') {
      await interaction.reply({ content: botHelpText(), ephemeral: true });
      return;
    }
    const guildId = this.requireGuild(interaction);
    this.requireAdmin(interaction);
    const projectId = parts[2] ?? 'root';
    if (action === 'start') {
      await interaction.reply({ ...(await this.setupPayload(guildId, interaction.channelId ?? '')), ephemeral: true });
      return;
    }
    if (action === 'project') {
      await interaction.reply({
        content: '先選擇團隊平常討論這個專案的文字頻道。',
        components: projectChannelPicker(),
        ephemeral: true,
      });
      return;
    }
    if (action === 'refresh') {
      await interaction.update(await this.setupPayload(guildId, interaction.channelId ?? '', projectId));
      return;
    }
    if (action === 'health') {
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply(await this.healthReport(interaction, project));
      return;
    }
    if (action === 'repository') {
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      await interaction.deferReply({ ephemeral: true });
      const installations = await this.github.listInstallations();
      if (installations.length === 0) {
        await interaction.editReply('❌ 找不到 GitHub App 安裝。請先在 GitHub 按 Install，再按這裡重新嘗試。');
        return;
      }
      if (installations.length === 1 && installations[0]) {
        await interaction.editReply(await this.repositorySelectionPayload(project, installations[0].id, 0));
        return;
      }
      await interaction.editReply({
        content: '📦 **選擇 GitHub 帳號**\nBot 已找到下列 GitHub App 安裝，不需要輸入 Installation ID。',
        components: repositoryInstallationPicker(project.bindingId, installations, project.githubInstallationId),
      });
      return;
    }
		if (action === 'ai-news') {
			if (!this.aiNews?.enabled) throw new ValidationError('AI 新聞功能尚未由系統管理員啟用。');
			await interaction.reply({
				content: '選擇團隊已建立的 #AI新聞。Bot 只會使用 View Channel、Send Messages 與 Read Message History。',
				components: aiNewsChannelPicker(),
				ephemeral: true,
			});
			return;
		}
		if (action === 'ai-news-preview') {
			if (!this.aiNews?.enabled) throw new ValidationError('AI 新聞功能尚未由系統管理員啟用。');
			const setting = await this.aiNews.store.findAiNewsSetting(guildId);
			if (!setting?.enabled) throw new ValidationError('請先設定 #AI新聞。');
			await this.queues.enqueue(
				'ai-news-digest',
				'preview',
				{ guildId, preview: true, requestedBy: interaction.user.id },
				{ jobId: `ai-news-preview-${interaction.id}`, attempts: 1 },
			);
			await interaction.reply({ content: `已開始整理測試早報，完成後會發布到 <#${setting.discordChannelId}>；這次不會占用正式發布紀錄。`, ephemeral: true });
			return;
		}
    if (action === 'repo-page') {
      const repositoryProjectId = parts[2] ?? 'root';
      const installationId = parts[3];
      const page = Number(parts[4] ?? '0');
      if (!installationId) throw new Error('GitHub App 安裝資訊已失效，請重新開啟設定。');
      const project = await this.projectForAction(repositoryProjectId, guildId, interaction.channelId ?? '');
      await interaction.deferUpdate();
      await interaction.editReply(await this.repositorySelectionPayload(project, installationId, page));
      return;
    }
    if (action === 'summary' || action === 'leave') {
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      await interaction.reply({
        content: action === 'summary'
          ? '選擇每天 16:30 提醒、17:00 發布彙整的頻道。'
          : '選擇發布請假與行程通知的頻道；這一項可以稍後再設定。',
        components: setupChannelPicker(project.bindingId, action),
        ephemeral: true,
      });
      return;
    }
    if (action === 'member') {
      await interaction.reply({
        content: '選擇一位成員，下一步只需要填他的 GitHub 帳號。由管理員確認 GitHub 帳號後完成綁定。',
        components: memberPicker(projectId),
        ephemeral: true,
      });
      return;
    }
    if (action === 'status') {
      await interaction.reply({ content: guildStatusText(await this.bindings.listByGuild(guildId)), ephemeral: true });
      return;
    }
    if (action === 'report-open' || action === 'report-summary') {
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      await interaction.deferReply({ ephemeral: true });
      const queueName = action === 'report-open' ? 'daily-report-reminder' : 'daily-summary';
      await this.queues.enqueue(
        queueName,
        'manual',
        { requestedBy: interaction.user.id, guildId, projectBindingId: project.bindingId },
        { jobId: `${action}-${interaction.id}`, attempts: 1 },
      );
      await interaction.editReply(action === 'report-open'
        ? `✅ 正在為「${project.name}」建立今天的工作回報討論串，約幾秒後會出現在 <#${project.summaryChannelId}>。`
        : `✅ 正在彙整「${project.name}」目前開啟的工作回報，完成後會發布到 <#${project.summaryChannelId}>。`);
      return;
    }
    await interaction.reply({ content: setupGuidance(action), ephemeral: true });
  }

  private async handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guildId = this.requireGuild(interaction);
    this.requireAdmin(interaction);
    if (interaction.customId === 'setup-project-select') {
      await interaction.update(await this.setupPayload(guildId, interaction.channelId ?? '', selectedValue(interaction.values, '專案')));
      return;
    }
    if (interaction.customId.startsWith('setup-project-installation:')) {
      const channelId = interaction.customId.split(':')[1];
      const installationId = selectedValue(interaction.values, 'GitHub 帳號');
      if (!channelId) throw new Error('Discord 頻道資訊已失效，請重新操作。');
      const channel = interaction.guild?.channels.cache.get(channelId);
      const option = interaction.component.options.find((item) => item.value === installationId);
      await interaction.showModal(projectDetailsModal({
        channelId,
        channelName: channel && 'name' in channel ? (channel.name ?? '專案') : '專案',
        installationId,
        accountLogin: option?.label ?? 'GitHub',
      }));
      return;
    }
    if (interaction.customId.startsWith('setup-repo-installation:')) {
      const projectId = interaction.customId.split(':')[1] ?? 'root';
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      const installationId = selectedValue(interaction.values, 'GitHub 帳號');
      await interaction.deferUpdate();
      await interaction.editReply(await this.repositorySelectionPayload(project, installationId, 0));
      return;
    }
    if (interaction.customId.startsWith('setup-repositories:')) {
      const [, projectId, installationId] = interaction.customId.split(':');
      if (!projectId || !installationId) throw new Error('Repository 選擇資訊已失效，請重新操作。');
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      await interaction.deferUpdate();
      const repositories = await this.github.listInstallationRepositories(installationId);
      const selectedIds = new Set(interaction.values);
      const selectedRepositories = repositories.filter((repository) => selectedIds.has(repository.id));
      if (selectedRepositories.length !== selectedIds.size) throw new Error('部分 Repository 已不存在，請重新選擇。');
      for (const repository of selectedRepositories) {
        await this.bindings.bindRepository({
          projectBindingId: project.bindingId,
          owner: repository.owner,
          name: repository.name,
          githubRepositoryId: repository.id,
          githubInstallationId: installationId,
        });
        await this.audit.append({
          actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.repository.upsert',
          resourceType: 'project_binding', resourceId: project.bindingId,
          after: {
            owner: repository.owner,
            repository: repository.name,
            repositoryId: repository.id,
            installationId,
          },
          requestId: `${interaction.id}-${repository.id}`,
        });
      }
      const payload = await this.setupPayload(guildId, interaction.channelId ?? '', project.bindingId);
      await interaction.editReply({
        content: `✅ 已加入 ${selectedRepositories.map((repository) => repository.fullName).join('、')}。\n\n${payload.content}`,
        components: payload.components,
      });
    }
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    const guildId = this.requireGuild(interaction);
    this.requireAdmin(interaction);
    const channelId = selectedValue(interaction.values, '頻道');
		if (interaction.customId === 'setup-ai-news-channel') {
			if (!this.aiNews?.enabled) throw new ValidationError('AI 新聞功能尚未由系統管理員啟用。');
			const before = await this.aiNews.store.findAiNewsSetting(guildId);
			const setting = await this.aiNews.store.upsertAiNewsSetting({
				discordGuildId: guildId,
				discordChannelId: channelId,
				enabled: true,
			});
			await this.audit.append({
				actorType: 'discord_user',
				actorId: interaction.user.id,
				action: 'ai_news.channel.update',
				resourceType: 'discord_guild',
				resourceId: guildId,
				...(before ? { before: { channelId: before.discordChannelId, enabled: before.enabled } } : {}),
				after: { channelId: setting.discordChannelId, enabled: setting.enabled },
				requestId: interaction.id,
			});
			const payload = await this.setupPayload(guildId, interaction.channelId ?? '');
			await interaction.update({
				content: `AI 新聞已設為 <#${channelId}>。平日 09:00 發布早報，週末仍可貼連結取得摘要。\n\n${payload.content}`,
				components: payload.components,
			});
			return;
		}
    if (interaction.customId === 'setup-project-channel') {
      await interaction.deferUpdate();
      const installations = await this.github.listInstallations();
      if (installations.length === 0) {
        await interaction.editReply({
          content: '❌ 尚未找到 GitHub App 安裝。請先在 GitHub App 頁面按 Install，再按「建立新專案」。',
          components: [],
        });
        return;
      }
      await interaction.editReply({
        content: '🔗 **選擇 GitHub 帳號**\nBot 已自動找到安裝，不需要複製網址或 ID。',
        components: installationPicker(channelId, installations),
      });
      return;
    }
    if (interaction.customId.startsWith('setup-channel-')) {
      const [kindWithPrefix, projectId] = interaction.customId.split(':');
      const kind = kindWithPrefix?.replace('setup-channel-', '');
      if (!projectId || (kind !== 'summary' && kind !== 'leave')) throw new Error('頻道設定資訊已失效。');
      const project = await this.projectForAction(projectId, guildId, interaction.channelId ?? '');
      if (kind === 'summary') await this.bindings.setSummaryChannel(project.bindingId, channelId);
      else await this.bindings.setLeaveChannel(project.bindingId, channelId);
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id,
        action: kind === 'summary' ? 'binding.summary_channel.update' : 'binding.leave_channel.update',
        resourceType: 'project_binding', resourceId: project.bindingId,
        after: { channelId }, requestId: interaction.id,
      });
      const payload = await this.setupPayload(guildId, interaction.channelId ?? '', project.bindingId);
      await interaction.update({
        content: `✅ ${kind === 'summary' ? '工作摘要' : '行程通知'}已設為 <#${channelId}>。\n\n${payload.content}`,
        components: payload.components,
      });
    }
  }

  private async handleUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    this.requireGuild(interaction);
    this.requireAdmin(interaction);
    if (!interaction.customId.startsWith('setup-member:')) return;
    const projectId = interaction.customId.split(':')[1] ?? 'root';
    const userId = selectedValue(interaction.values, '成員');
    const user = interaction.users.get(userId);
    if (!user) throw new NotFoundError('找不到剛才選擇的成員。');
    await interaction.showModal(memberLoginModal(userId, projectId, user.username));
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = this.requireGuild(interaction);
    this.requireAdmin(interaction);
    if (interaction.customId.startsWith('setup-project-modal:')) {
      const [, channelId, installationId] = interaction.customId.split(':');
      if (!channelId || !installationId) throw new Error('專案設定資訊已失效，請重新操作。');
      await interaction.deferReply({ ephemeral: true });
      const installations = await this.github.listInstallations();
      const installation = installations.find((item) => item.id === installationId);
      if (!installation) throw new NotFoundError('這個 GitHub App 安裝已不存在，請重新安裝後再試。');
      await this.github.checkConnection(installationId);
      const name = interaction.fields.getTextInputValue('project-name').trim();
      const githubProjectId = interaction.fields.getTextInputValue('project-id').trim();
      const project = await this.bindings.bindProject({
        name,
        discordGuildId: guildId,
        discordChannelId: channelId,
        githubOrganization: installation.accountLogin,
        githubInstallationId: installation.id,
        ...(githubProjectId ? { githubProjectId } : {}),
      });
      await this.audit.append({
        actorType: 'discord_user', actorId: interaction.user.id, action: 'binding.project.create',
        resourceType: 'project_binding', resourceId: project.bindingId,
        after: {
          name,
          discordChannelId: channelId,
          githubOrganization: installation.accountLogin,
          githubInstallationId: installation.id,
          githubProjectId: githubProjectId || null,
        },
        requestId: interaction.id,
      });
      const payload = await this.setupPayload(guildId, interaction.channelId ?? '', project.bindingId);
      await interaction.editReply({
        content: `✅ 專案「${name}」已連接至 GitHub ${installation.accountLogin}。\n\n${payload.content}`,
        components: payload.components,
      });
      return;
    }
    if (interaction.customId.startsWith('setup-member-modal:')) {
      const [, userId, projectId = 'root'] = interaction.customId.split(':');
      if (!userId) throw new Error('成員設定資訊已失效，請重新操作。');
      await interaction.deferReply({ ephemeral: true });
      const user = await interaction.client.users.fetch(userId);
      const githubLogin = interaction.fields.getTextInputValue('github-login');
      await this.linkPerson({
        actorId: interaction.user.id,
        requestId: interaction.id,
        userId,
        displayName: user.globalName ?? user.username,
        githubLogin,
      });
      const payload = await this.setupPayload(guildId, interaction.channelId ?? '', projectId);
      await interaction.editReply({
        content: `✅ 已綁定 <@${userId}> ↔ GitHub @${githubLogin.trim().replace(/^@/u, '')}。\n\n${payload.content}`,
        components: payload.components,
      });
    }
  }

  private async repositorySelectionPayload(project: ProjectContext, installationId: string, page: number) {
    const [repositories, guildProjects] = await Promise.all([
      this.github.listInstallationRepositories(installationId),
      this.bindings.listByGuild(project.discordGuildId),
    ]);
    const bound = new Set(guildProjects.flatMap((candidate) => candidate.repositories.map(
      (repository) => `${repository.owner}/${repository.name}`.toLowerCase(),
    )));
    const available = repositories.filter((repository) => !bound.has(repository.fullName.toLowerCase()));
    if (available.length === 0) {
      return {
        content: '✅ 這個 GitHub App 安裝內的 Repository 都已綁定，沒有需要新增的項目。',
        components: [],
      };
    }
    const pageCount = Math.ceil(available.length / 25);
    const safePage = Math.min(Math.max(Number.isFinite(page) ? page : 0, 0), pageCount - 1);
    return {
      content: `📦 **勾選要加入「${project.name}」的 Repository**\n可一次選多個；已綁定的 Repo 會自動隱藏。第 ${safePage + 1}/${pageCount} 頁`,
      components: repositoryPickerRows({
        projectId: project.bindingId,
        installationId,
        repositories: available,
        page: safePage,
      }),
    };
  }

  private async healthReport(interaction: ButtonInteraction, project: ProjectContext): Promise<string> {
    const lines = [`🩺 **${project.name} 健康檢查**`];
    try {
      await this.github.checkConnection(project.githubInstallationId);
      lines.push('✅ GitHub App：連線與授權正常');
    } catch (error) {
      lines.push(discordErrorMessage(error, 'GitHub App 連線失敗。'));
    }

    const repositoriesByInstallation = new Map<string, GitHubRepositoryChoice[]>();
    for (const repository of project.repositories) {
      const installationId = repository.githubInstallationId ?? project.githubInstallationId;
      try {
        let accessible = repositoriesByInstallation.get(installationId);
        if (!accessible) {
          accessible = await this.github.listInstallationRepositories(installationId);
          repositoriesByInstallation.set(installationId, accessible);
        }
        const found = accessible.some((candidate) => (
          candidate.owner.toLowerCase() === repository.owner.toLowerCase()
          && candidate.name.toLowerCase() === repository.name.toLowerCase()
        ));
        lines.push(`${found ? '✅' : '❌'} Repository：${repository.owner}/${repository.name}${found ? '' : '（App 無權限）'}`);
				if (found && this.commitHistoryEnabled) {
					try {
						await this.github.checkCommitAccess(installationId, repository.owner, repository.name);
						lines.push(`✅ Commit history：${repository.owner}/${repository.name}`);
					} catch (error) {
						lines.push(discordErrorMessage(error, `Commit history 無法讀取 ${repository.owner}/${repository.name}，請確認 Contents: Read-only 權限。`));
					}
				}
      } catch (error) {
        lines.push(discordErrorMessage(error, `無法檢查 ${repository.owner}/${repository.name}。`));
      }
    }

    const botMember = interaction.guild?.members.me ?? await interaction.guild?.members.fetchMe();
    const channelChecks = [
      { label: '專案討論', id: project.discordChannelId, thread: false },
      ...(project.summaryChannelId ? [{ label: '工作摘要', id: project.summaryChannelId, thread: true }] : []),
      ...(project.leaveChannelId ? [{ label: '行程通知', id: project.leaveChannelId, thread: false }] : []),
    ];
		const aiNewsSetting = await this.aiNews?.store.findAiNewsSetting(project.discordGuildId);
		if (aiNewsSetting?.enabled) {
			channelChecks.push({ label: 'AI 新聞', id: aiNewsSetting.discordChannelId, thread: false });
		}
    for (const check of channelChecks) {
      const channel = await interaction.guild?.channels.fetch(check.id);
      const permissions = channel && botMember ? channel.permissionsFor(botMember) : null;
      const baseAllowed = Boolean(permissions?.has(PermissionFlagsBits.ViewChannel)
        && permissions.has(PermissionFlagsBits.SendMessages)
        && permissions.has(PermissionFlagsBits.ReadMessageHistory));
      const threadAllowed = !check.thread || Boolean(permissions?.has(PermissionFlagsBits.CreatePublicThreads)
        && permissions.has(PermissionFlagsBits.SendMessagesInThreads));
      lines.push(`${baseAllowed && threadAllowed ? '✅' : '❌'} ${check.label}：<#${check.id}>${baseAllowed && threadAllowed ? ' 權限正常' : ' 缺少檢視、傳送、歷史訊息或討論串權限'}`);
    }
    lines.push('🟡 Azure AI：請按「測試 17:00 彙整」做端到端驗證');
    return lines.join('\n');
  }
}
