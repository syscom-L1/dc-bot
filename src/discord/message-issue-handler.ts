import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { discordErrorMessage, ForbiddenError, NotFoundError } from '../common/errors.js';
import type { IssueDraftService, DiscordSourceMessage } from '../issues/issue-draft.js';
import {
  IssueCreationService,
  type IssueProposalStore,
  issueCreationActionSchema,
  renderIssuePreview,
} from '../issues/issue-creation.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';
import type { DiscordAccessPolicy } from './access-policy.js';

function proposalButtons(proposalId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`issue:confirm:${proposalId}`).setLabel('確認建立').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`issue:edit:${proposalId}`).setLabel('修改').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`issue:cancel:${proposalId}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
}

function sourceFromMessage(message: Message): DiscordSourceMessage {
  const attachments = [...message.attachments.values()].map((attachment) => attachment.url);
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.author.globalName ?? message.author.username,
    content: [message.content, ...attachments].filter(Boolean).join('\n').slice(0, 8_000),
    url: message.url,
    createdAt: message.createdAt.toISOString(),
  };
}

async function gatherSources(target: Message): Promise<DiscordSourceMessage[]> {
  if (!target.channel.isTextBased() || !('messages' in target.channel)) return [sourceFromMessage(target)];
  const recent = await target.channel.messages.fetch({ limit: 25 });
  if (!recent.has(target.id)) recent.set(target.id, target);
  return [...recent.values()]
    .filter((message) => !message.author.bot && (message.content.length > 0 || message.attachments.size > 0))
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(sourceFromMessage);
}

export class DiscordMessageIssueHandler {
  public constructor(
    private readonly policy: DiscordAccessPolicy,
    private readonly bindings: ProjectBindingStore,
    private readonly drafts: IssueDraftService,
    private readonly issues: IssueCreationService,
    private readonly issueProposals: IssueProposalStore,
    private readonly logger: Logger,
  ) {}

  public register(client: Client): void {
    client.on('interactionCreate', (interaction) => {
      if (!this.handles(interaction)) return;
      void this.handle(interaction).catch(async (error: unknown) => {
        this.logger.error({ err: error, interactionId: interaction.id }, 'message-to-issue interaction failed');
        const content = discordErrorMessage(error, 'Issue 提案處理失敗，請稍後再試。');
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
          else await interaction.reply({ content, ephemeral: true });
        }
      });
    });
  }

  private handles(interaction: Interaction): boolean {
    if (interaction.isMessageContextMenuCommand()) return interaction.commandName === '建立 GitHub Issue';
    if (interaction.isButton()) return interaction.customId.startsWith('issue:');
    return interaction.isModalSubmit() && interaction.customId.startsWith('issue:edit-modal:');
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isMessageContextMenuCommand()) await this.createDraft(interaction);
    else if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isModalSubmit()) await this.handleEdit(interaction);
  }

  private async createDraft(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    if (!this.policy.isGuildAllowed(interaction.guildId) || !interaction.guildId) {
      throw new ForbiddenError('此 Guild 未授權使用 Bot');
    }
    const channel = interaction.channel;
    const bindingChannelId = channel?.isThread() ? channel.parentId : interaction.channelId;
    if (!bindingChannelId) throw new NotFoundError('找不到 Thread 的專案頻道');
    const project = await this.bindings.findByDiscordChannel(interaction.guildId, bindingChannelId);
    if (!project) throw new ForbiddenError('此頻道尚未綁定 GitHub 專案');
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.targetMessage.partial
      ? await interaction.targetMessage.fetch()
      : interaction.targetMessage;
    const sources = await gatherSources(target);
    const generated = await this.drafts.generate(project, sources, interaction.user.id);
    const action = await this.issues.saveDraft({
      proposalId: generated.proposalId,
      requestedBy: interaction.user.id,
      traceId: generated.traceId,
      draft: generated.draft,
      bindingId: project.bindingId,
      installationId: generated.repository.githubInstallationId ?? project.githubInstallationId,
      discordGuildId: interaction.guildId,
      discordChannelId: bindingChannelId,
      discordThreadId: channel?.isThread() ? channel.id : null,
      sourceMessageId: target.id,
      owner: generated.repository.owner,
      repository: generated.repository.name,
      ...(project.githubProjectId ? { projectId: project.githubProjectId } : {}),
      targetDateFieldName: project.config.githubProjectFields.targetDate,
      sources,
    });
    await interaction.editReply({ content: renderIssuePreview(action), components: [proposalButtons(action.proposalId)] });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, proposalId] = interaction.customId.split(':');
    if (!action || !proposalId) return;
    if (action === 'confirm') {
      await interaction.deferReply({ ephemeral: true });
      const url = await this.issues.execute(proposalId, interaction.user.id, randomUUID());
      await interaction.editReply(`GitHub Issue 已建立並寫入 Audit Log：${url}`);
      return;
    }
    if (action === 'cancel') {
      await this.issues.reject(proposalId, interaction.user.id);
      await interaction.reply({ content: '已取消，GitHub 未被修改。', ephemeral: true });
      return;
    }
    if (action === 'edit') {
      const proposal = await this.issueProposals.find(proposalId);
      if (!proposal || proposal.requestedBy !== interaction.user.id || proposal.status !== 'PROPOSED') {
        throw new ForbiddenError('此 Issue 提案不可編輯');
      }
      const current = issueCreationActionSchema.parse(proposal.action);
      const modal = new ModalBuilder().setCustomId(`issue:edit-modal:${proposalId}`).setTitle('修改 GitHub Issue 草稿');
      const title = new TextInputBuilder()
        .setCustomId('title')
        .setStyle(TextInputStyle.Short)
        .setMinLength(3)
        .setMaxLength(200)
        .setValue(current.title)
        .setRequired(true);
      const body = new TextInputBuilder()
        .setCustomId('body')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(1)
        .setMaxLength(4_000)
        .setValue(current.body.slice(0, 4_000))
        .setRequired(true);
      modal.addLabelComponents(
        new LabelBuilder().setLabel('Title').setTextInputComponent(title),
        new LabelBuilder().setLabel('Body（Discord 最多 4000 字）').setTextInputComponent(body),
      );
      await interaction.showModal(modal);
    }
  }

  private async handleEdit(interaction: ModalSubmitInteraction): Promise<void> {
    const proposalId = interaction.customId.split(':')[2];
    if (!proposalId) return;
    const action = await this.issues.edit(
      proposalId,
      interaction.user.id,
      interaction.fields.getTextInputValue('title'),
      interaction.fields.getTextInputValue('body'),
    );
    await interaction.reply({
      content: renderIssuePreview(action),
      components: [proposalButtons(proposalId)],
      ephemeral: true,
    });
  }
}
