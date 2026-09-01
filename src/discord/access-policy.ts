export interface DiscordAccessContext {
  guildId: string | null;
  channelId: string;
  roleIds: string[];
}

export class DiscordAccessPolicy {
  public constructor(
    private readonly allowedGuildIds: ReadonlySet<string>,
    private readonly allowedChannelIds: ReadonlySet<string>,
    private readonly adminRoleId: string,
    private readonly adminChannelId: string,
  ) {}

  public isGuildAllowed(guildId: string | null): boolean {
    return guildId !== null && this.allowedGuildIds.size > 0 && this.allowedGuildIds.has(guildId);
  }

  public isChannelAllowed(channelId: string): boolean {
    return this.allowedChannelIds.has(channelId) || channelId === this.adminChannelId;
  }

  public isAdmin(context: DiscordAccessContext): boolean {
    const isAdminChannel = this.adminChannelId.length > 0 && context.channelId === this.adminChannelId;
    const hasAdminRole = this.adminRoleId.length > 0 && context.roleIds.includes(this.adminRoleId);
    return this.isGuildAllowed(context.guildId) && (isAdminChannel || hasAdminRole);
  }
}
