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
import { AppError } from '../common/errors.js';
import { formatLeaveTime, type LeaveRecord, type LeaveService } from '../leave/leave-service.js';
import type { ProjectBindingStore } from '../persistence/contracts.js';
import type { DiscordAccessPolicy } from './access-policy.js';

function leaveButtons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`leave:confirm:${id}`).setLabel('確認').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave:edit:${id}`).setLabel('修改').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`leave:cancel:${id}`).setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
}

function card(record: LeaveRecord): string {
  return `請確認請假通知：\n\n人員：${record.person.displayName}\n時間：${formatLeaveTime(record.startAt, record.endAt)}\n\n不會保存請假原因或假別。`;
}

function editableDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
}

export class DiscordLeaveHandler {
  public constructor(
    private readonly policy: DiscordAccessPolicy,
    private readonly leaveChannelId: string,
    private readonly bindings: ProjectBindingStore,
    private readonly leaves: LeaveService,
    private readonly logger: Logger,
  ) {}

  public register(client: Client): void {
    client.on('messageCreate', (message) => {
      if (message.author.bot || !/(請假|休假|不在)/u.test(message.content)) return;
      void this.handleMessage(message);
    });

    client.on('interactionCreate', (interaction) => {
      if (!this.handles(interaction)) return;
      void this.handle(interaction).catch(async (error: unknown) => {
        this.logger.error({ err: error, interactionId: interaction.id }, 'leave interaction failed');
        const content = error instanceof AppError || error instanceof Error ? error.message : '請假操作失敗';
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
          else await interaction.reply({ content, ephemeral: true });
        }
      });
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.guildId || !this.policy.isGuildAllowed(message.guildId)) return;
    const databaseBinding = await this.bindings.findByLeaveChannel(message.guildId, message.channelId);
    if (message.channelId !== this.leaveChannelId && !databaseBinding) return;
    try {
      const record = await this.leaves.propose({
        text: message.content,
        actorDiscordId: message.author.id,
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        now: message.createdAt,
      });
      await message.reply({
        content: card(record),
        components: [leaveButtons(record.id)],
        allowedMentions: { repliedUser: false },
      });
    } catch (error) {
      this.logger.warn({ err: error, messageId: message.id }, 'leave message parsing failed');
      const content = error instanceof Error ? error.message : '無法解析請假時間';
      await message.reply({
        content: `請假通知尚未建立：${content}`,
        allowedMentions: { repliedUser: false },
      });
    }
  }

  private handles(interaction: Interaction): boolean {
    if (interaction.isButton()) return interaction.customId.startsWith('leave:');
    return interaction.isModalSubmit() && interaction.customId.startsWith('leave:edit-modal:');
  }

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) await this.handleButton(interaction);
    else if (interaction.isModalSubmit()) await this.handleModal(interaction);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, id] = interaction.customId.split(':');
    if (!action || !id) return;
    if (action === 'confirm') {
      const record = await this.leaves.confirm(id, interaction.user.id);
      await interaction.reply({
        content: `已確認：${record.person.displayName}，${formatLeaveTime(record.startAt, record.endAt)}`,
        ephemeral: true,
      });
      return;
    }
    if (action === 'cancel') {
      await this.leaves.cancel(id, interaction.user.id);
      await interaction.reply({ content: '已取消請假通知。', ephemeral: true });
      return;
    }
    if (action === 'edit') {
      const record = await this.leaves.findEditable(id, interaction.user.id);
      const start = new TextInputBuilder()
        .setCustomId('start')
        .setStyle(TextInputStyle.Short)
        .setValue(editableDate(record.startAt))
        .setRequired(true);
      const end = new TextInputBuilder()
        .setCustomId('end')
        .setStyle(TextInputStyle.Short)
        .setValue(editableDate(record.endAt))
        .setRequired(true);
      const modal = new ModalBuilder()
        .setCustomId(`leave:edit-modal:${id}`)
        .setTitle('修改請假時間')
        .addLabelComponents(
          new LabelBuilder().setLabel('開始（YYYY-MM-DD HH:mm）').setTextInputComponent(start),
          new LabelBuilder().setLabel('結束（YYYY-MM-DD HH:mm）').setTextInputComponent(end),
        );
      await interaction.showModal(modal);
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const id = interaction.customId.split(':')[2];
    if (!id) return;
    const record = await this.leaves.edit(
      id,
      interaction.user.id,
      interaction.fields.getTextInputValue('start'),
      interaction.fields.getTextInputValue('end'),
    );
    await interaction.reply({ content: card(record), components: [leaveButtons(id)], ephemeral: true });
  }
}
