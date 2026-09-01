import { describe, expect, it } from 'vitest';
import { DiscordAccessPolicy } from '../../src/discord/access-policy.js';

describe('DiscordAccessPolicy', () => {
  const policy = new DiscordAccessPolicy(
    new Set(['guild-1']),
    new Set(['project-channel']),
    'admin-role',
    'admin-channel',
  );

  it('denies unknown guilds and allows configured guild/channel only', () => {
    expect(policy.isGuildAllowed('guild-1')).toBe(true);
    expect(policy.isGuildAllowed('guild-2')).toBe(false);
    expect(policy.isChannelAllowed('project-channel')).toBe(true);
    expect(policy.isChannelAllowed('random-channel')).toBe(false);
  });

  it('permits administration via private channel or configured role', () => {
    expect(policy.isAdmin({ guildId: 'guild-1', channelId: 'admin-channel', roleIds: [] })).toBe(true);
    expect(policy.isAdmin({ guildId: 'guild-1', channelId: 'elsewhere', roleIds: ['admin-role'] })).toBe(true);
    expect(policy.isAdmin({ guildId: 'guild-1', channelId: 'elsewhere', roleIds: [] })).toBe(false);
  });
});
