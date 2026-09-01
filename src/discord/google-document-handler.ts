import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import type { DiscussionMessage } from '../ai/discussion-service.js';
import { AppError } from '../common/errors.js';
import {
  renderDocumentDiff,
  type DocumentBindingStore,
  type GoogleDocumentProposalService,
} from '../google/document-service.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';
import { splitDiscordMessage } from '../summaries/daily-summary.js';
import type { DiscordAccessPolicy } from './access-policy.js';

const documentIdPattern = /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/u;

function buttons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`doc:diff:${id}`).setLabel('查看完整差異').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`doc:comment:${id}`).setLabel('以留言提出').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`doc:write:${id}`).setLabel('直接寫入').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`doc:edit:${id}`).setLabel('修改內容').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`doc:cancel:${id}`).setLabel('取消').setStyle(ButtonStyle.Danger),
  );
}

function discussionMessage(message: Message): DiscussionMessage {
  return {
    author: message.author.globalName ?? message.author.username,
    content: message.content.slice(0, 8_000),
    createdAt: message.createdAt.toISOString(),
    url: message.url,
  };
}

export class DiscordGoogleDocumentHandler {
  public constructor(
    private readonly policy: DiscordAccessPolicy,
    private readonly projects: ProjectBindingStore,
    private readonly bindings: DocumentBindingStore,
    private readonly documents: GoogleDocumentProposalService,
    private readonly logger: Logger,
  ) {}

  public register(client: Client): void {
    client.on('messageCreate', (message) => {
      const bot = client.user;
      if (!bot || message.author.bot || !message.mentions.has(bot) || !/(文件|docs?|document)/iu.test(message.content)) return;
      void this.handleMessage(message, bot.id);
    });
    client.on('interactionCreate', (interaction) => {
      if (!this.handles(interaction)) return;
      void this.handleInteraction(interaction).catch(async (error: unknown) => {
        this.logger.error({ err: error, interactionId: interaction.id }, 'Google document interaction failed');
        const content = error instanceof AppError || error instanceof Error ? error.message : 'Google 文件操作失敗';
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
          else await interaction.reply({ content, ephemeral: true });
        }
      });
    });
  }

  private async handleMessage(message: Message, botId: string): Promise<void> {
    try {
      if (!message.guildId || !this.policy.isGuildAllowed(message.guildId)) return;
      const projectChannelId = message.channel.isThread() ? message.channel.parentId : message.channelId;
      if (!projectChannelId) return;
      const project = await this.projects.findByDiscordChannel(message.guildId, projectChannelId);
      if (!project) return;
      const available = await this.bindings.listForProject(project.bindingId);
      const requestedDocumentId = message.content.match(documentIdPattern)?.[1];
      const binding = requestedDocumentId
        ? available.find((item) => item.documentId === requestedDocumentId)
        : available.length === 1 ? available[0] : undefined;
      if (!binding) {
        await message.reply({
          content: requestedDocumentId
            ? '此 Google 文件不在目前專案允許清單。'
            : '目前專案有零或多份綁定文件，請貼上要操作的 Google Docs 連結。',
          allowedMentions: { repliedUser: false },
        });
        return;
      }
      const recent = message.channel.isTextBased() && 'messages' in message.channel
        ? await message.channel.messages.fetch({ limit: 25 })
        : null;
      const discussion = recent
        ? [...recent.values()]
            .filter((item) => !item.author.bot && item.content.length > 0)
            .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
            .map(discussionMessage)
        : [discussionMessage(message)];
      const prompt = message.content.replaceAll(`<@${botId}>`, '').replaceAll(`<@!${botId}>`, '').trim();
      const action = await this.documents.prepare({ requestedBy: message.author.id, prompt, messages: discussion, binding });
      await message.reply({
        content: renderDocumentDiff(action),
        components: [buttons(action.proposalId)],
        allowedMentions: { repliedUser: false },
      });
    } catch (error) {
      this.logger.error({ err: error, messageId: message.id }, 'Google document proposal failed');
      await message.reply({ content: error instanceof Error ? error.message : 'Google 文件提案失敗', allowedMentions: { repliedUser: false } });
    }
  }

  private handles(interaction: Interaction): boolean {
    if (interaction.isButton()) return interaction.customId.startsWith('doc:');
    return interaction.isModalSubmit() && interaction.customId.startsWith('doc:edit-modal:');
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isModalSubmit()) await this.handleModal(interaction);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, id] = interaction.customId.split(':');
    if (!action || !id) return;
    if (action === 'cancel') {
      await this.documents.reject(id, interaction.user.id);
      await interaction.reply({ content: '已取消，Google 文件未被修改。', ephemeral: true });
      return;
    }
    if (action === 'diff') {
      const proposal = await this.documents.find(id, interaction.user.id);
      const chunks = splitDiscordMessage(renderDocumentDiff(proposal, true));
      await interaction.reply({ content: chunks[0] ?? '沒有差異', ephemeral: true });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, ephemeral: true });
      return;
    }
    if (action === 'edit') {
      const proposal = await this.documents.find(id, interaction.user.id);
      const content = new TextInputBuilder()
        .setCustomId('content')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4_000)
        .setValue(proposal.content.slice(0, 4_000))
        .setRequired(true);
      const modal = new ModalBuilder()
        .setCustomId(`doc:edit-modal:${id}`)
        .setTitle('修改文件提案')
        .addLabelComponents(new LabelBuilder().setLabel('新內容').setTextInputComponent(content));
      await interaction.showModal(modal);
      return;
    }
    if (action === 'comment') {
      await interaction.deferReply({ ephemeral: true });
      await this.documents.update(id, interaction.user.id, { mode: 'comment' });
      await this.documents.execute(id, interaction.user.id, randomUUID());
      await interaction.editReply('已在 Google 文件建立留言建議並寫入 Audit Log。');
      return;
    }
    if (action === 'write') {
      const proposal = await this.documents.find(id, interaction.user.id);
      if (proposal.requiresSecondConfirmation) {
        const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`doc:confirm-large:${id}`).setLabel('再次確認大範圍修改').setStyle(ButtonStyle.Danger),
        );
        await interaction.reply({ content: '這次修改範圍很大。請檢查完整差異後再次確認。', components: [confirm], ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await this.documents.execute(id, interaction.user.id, randomUUID());
      await interaction.editReply('Google 文件已更新並寫入 Audit Log。');
      return;
    }
    if (action === 'confirm-large') {
      await interaction.deferReply({ ephemeral: true });
      await this.documents.execute(id, interaction.user.id, randomUUID(), true);
      await interaction.editReply('Google 文件的大範圍修改已完成並寫入 Audit Log。');
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const id = interaction.customId.split(':')[2];
    if (!id) return;
    const action = await this.documents.update(id, interaction.user.id, {
      content: interaction.fields.getTextInputValue('content'),
    });
    await interaction.reply({ content: renderDocumentDiff(action), components: [buttons(id)], ephemeral: true });
  }
}
