import {
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

export function discordCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  const bot = new SlashCommandBuilder()
    .setName('bot')
    .setDescription('管理 Discord 團隊工作助理')
    .addSubcommand((command) => command.setName('help').setDescription('查看 Bot 使用方式'))
    .addSubcommand((command) => command.setName('setup').setDescription('開啟一步一步快速設定精靈'))
    .addSubcommand((command) => command.setName('panel').setDescription('在管理頻道建立操作面板'))
    .addSubcommand((command) => command
      .setName('user-link')
      .setDescription('綁定 Discord 與 GitHub 使用者')
      .addUserOption((option) => option.setName('user').setDescription('Discord 使用者').setRequired(true))
      .addStringOption((option) => option.setName('github-login').setDescription('GitHub login').setRequired(true)))
    .addSubcommand((command) => command
      .setName('bind-project')
      .setDescription('綁定目前 Discord 頻道與 GitHub Project')
      .addStringOption((option) => option.setName('name').setDescription('專案顯示名稱').setRequired(true))
      .addStringOption((option) => option.setName('organization').setDescription('GitHub organization').setRequired(true))
      .addStringOption((option) => option.setName('installation-id').setDescription('GitHub App installation ID').setRequired(true))
      .addStringOption((option) => option.setName('project-id').setDescription('GitHub Project V2 node ID').setRequired(false)))
    .addSubcommand((command) => command
      .setName('bind-repository')
      .setDescription('將 GitHub Repository 綁定至目前專案')
      .addStringOption((option) => option.setName('owner').setDescription('Repository owner').setRequired(true))
      .addStringOption((option) => option.setName('repository').setDescription('Repository name').setRequired(true))
      .addStringOption((option) => option.setName('repository-id').setDescription('GitHub Repository node ID').setRequired(false))
      .addStringOption((option) => option
        .setName('installation-id')
        .setDescription('不同 GitHub 帳號的 App Installation ID；同帳號可留空')
        .setRequired(false)))
    .addSubcommand((command) => command
      .setName('bind-summary-channel')
      .setDescription('設定專案摘要頻道')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('摘要頻道')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)))
    .addSubcommand((command) => command
      .setName('bind-leave-channel')
      .setDescription('設定請假通知頻道')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('請假頻道')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)))
    .addSubcommand((command) => command
      .setName('bind-document')
      .setDescription('將允許的 Google Docs 綁定至目前專案')
      .addStringOption((option) => option.setName('url').setDescription('Google Docs URL').setRequired(true))
      .addStringOption((option) => option.setName('name').setDescription('文件顯示名稱').setRequired(true))
      .addStringOption((option) => option.setName('operations').setDescription('comment,insert,replace').setRequired(true)))
    .addSubcommand((command) => command.setName('status').setDescription('顯示目前頻道的整合狀態'));

  return [
    bot.toJSON(),
    new ContextMenuCommandBuilder()
      .setName('建立 GitHub Issue')
      .setType(ApplicationCommandType.Message)
      .toJSON(),
  ];
}
