import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { discordCommands } from '../src/discord/commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildIds = process.env.DISCORD_GUILD_IDS?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
if (!token || !clientId || guildIds.length === 0) {
  throw new Error('DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_IDS are required');
}

const rest = new REST({ version: '10' }).setToken(token);
await Promise.all(guildIds.map(async (guildId) => {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: discordCommands() });
  process.stdout.write(`Registered commands for guild ${guildId}\n`);
}));
