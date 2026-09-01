import { LeaveNoticeStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { DiscordAdapter } from '../../src/domain/adapters.js';
import { LeaveService, type LeaveRecord, type LeaveStore } from '../../src/leave/leave-service.js';

class FakeLeaveStore implements LeaveStore {
  public record: LeaveRecord | null = null;
  public notified = false;

  public async findPerson() {
    return { id: 'person-1', displayName: 'Alice', discordUserId: 'discord-alice' };
  }
  public async createProposal(input: {
    startAt: Date;
    endAt: Date;
    sourceMessageId: string;
    sourceChannelId: string;
    createdBy: string;
  }): Promise<LeaveRecord> {
    this.record = {
      id: 'leave-1',
      person: { id: 'person-1', displayName: 'Alice', discordUserId: 'discord-alice' },
      startAt: input.startAt,
      endAt: input.endAt,
      sourceMessageId: input.sourceMessageId,
      sourceChannelId: input.sourceChannelId,
      createdBy: input.createdBy,
      status: LeaveNoticeStatus.PROPOSED,
    };
    return this.record;
  }
  public async find(): Promise<LeaveRecord | null> { return this.record; }
  public async updateTimes(_id: string, _actor: string, startAt: Date, endAt: Date): Promise<LeaveRecord> {
    if (!this.record) throw new Error('missing');
    this.record.startAt = startAt;
    this.record.endAt = endAt;
    return this.record;
  }
  public async confirm(_id: string, actor: string): Promise<LeaveRecord | null> {
    if (!this.record || this.record.createdBy !== actor || this.record.status !== LeaveNoticeStatus.PROPOSED) return null;
    this.record.status = LeaveNoticeStatus.CONFIRMED;
    return this.record;
  }
  public async cancel(): Promise<boolean> { return false; }
  public async listMorningDue(): Promise<LeaveRecord[]> {
    return this.record?.status === LeaveNoticeStatus.CONFIRMED && !this.notified ? [this.record] : [];
  }
  public async markMorningNotified(): Promise<boolean> {
    if (this.notified) return false;
    this.notified = true;
    return true;
  }
}

class FakeDiscord implements DiscordAdapter {
  public readonly messages: string[] = [];
  public async sendChannelMessage(_channel: string, content: string): Promise<string> {
    this.messages.push(content);
    return String(this.messages.length);
  }
  public async sendDirectMessage(): Promise<string> { return 'dm'; }
  public async checkConnection(): Promise<void> {}
}

describe('leave confirmation flow', () => {
  it('stores a proposal, notifies only after confirmation, and sends one morning reminder', async () => {
    const store = new FakeLeaveStore();
    const discord = new FakeDiscord();
    const service = new LeaveService(store, discord);
    const leave = await service.propose({
      text: '我明天請假一天',
      actorDiscordId: 'discord-alice',
      sourceMessageId: 'message-1',
      sourceChannelId: 'leave-channel',
      now: new Date('2026-08-28T03:00:00.000Z'),
    });
    expect(leave.status).toBe(LeaveNoticeStatus.PROPOSED);
    expect(discord.messages).toHaveLength(0);
    await expect(service.confirm(leave.id, 'discord-bob')).rejects.toThrow();
    expect(discord.messages).toHaveLength(0);

    await service.confirm(leave.id, 'discord-alice');
    expect(discord.messages).toHaveLength(1);
    expect(discord.messages[0]).not.toContain('原因');
    expect(await service.sendMorningNotifications(new Date('2026-08-29T00:00:00.000Z'))).toBe(1);
    expect(await service.sendMorningNotifications(new Date('2026-08-29T00:01:00.000Z'))).toBe(0);
    expect(discord.messages).toHaveLength(2);
  });
});
