import { ApplicationCommandType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { discordCommands } from '../../src/discord/commands.js';

describe('Discord command registration', () => {
  it('includes bot administration and the message context menu', () => {
    const commands = discordCommands();
    const bot = commands.find((command) => command.name === 'bot');
    expect(bot).toBeDefined();
    expect(JSON.stringify(bot)).toContain('"name":"help"');
    expect(JSON.stringify(bot)).toContain('"name":"panel"');
    expect(JSON.stringify(bot)).toContain('"name":"setup"');
    expect(JSON.stringify(bot)).toContain('不同 GitHub 帳號的 App Installation ID');
    expect(commands).toContainEqual(expect.objectContaining({
      name: '建立 GitHub Issue',
      type: ApplicationCommandType.Message,
    }));
  });
});
