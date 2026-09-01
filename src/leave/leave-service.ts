import { LeaveNoticeStatus, PrismaClient } from '@prisma/client';
import type { DiscordAdapter } from '../domain/adapters.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import type { AuditStore } from '../persistence/contracts.js';
import { parseLeaveText, parseTaipeiDateTime, taipeiDayBounds, type ParsedLeave } from './leave-parser.js';

export interface LeavePerson {
  id: string;
  displayName: string;
  discordUserId: string;
}

export interface LeaveRecord {
  id: string;
  person: LeavePerson;
  startAt: Date;
  endAt: Date;
  sourceMessageId: string;
  sourceChannelId: string;
  createdBy: string;
  status: LeaveNoticeStatus;
}

export interface LeaveStore {
  findPerson(discordUserId: string, displayNameHint: string | null): Promise<LeavePerson | null>;
  createProposal(input: {
    personId: string;
    startAt: Date;
    endAt: Date;
    sourceMessageId: string;
    sourceChannelId: string;
    createdBy: string;
  }): Promise<LeaveRecord>;
  find(id: string): Promise<LeaveRecord | null>;
  updateTimes(id: string, actorId: string, startAt: Date, endAt: Date): Promise<LeaveRecord>;
  confirm(id: string, actorId: string): Promise<LeaveRecord | null>;
  cancel(id: string, actorId: string): Promise<boolean>;
  listMorningDue(start: Date, end: Date): Promise<LeaveRecord[]>;
  markMorningNotified(id: string): Promise<boolean>;
}

export class PrismaLeaveStore implements LeaveStore {
  public constructor(private readonly client: PrismaClient) {}

  public async findPerson(discordUserId: string, displayNameHint: string | null): Promise<LeavePerson | null> {
    const person = displayNameHint
      ? await this.client.person.findFirst({
          where: { displayName: { equals: displayNameHint, mode: 'insensitive' }, enabled: true },
        })
      : await this.client.person.findFirst({ where: { discordUserId, enabled: true } });
    return person ? { id: person.id, displayName: person.displayName, discordUserId: person.discordUserId } : null;
  }

  private static record(value: {
    id: string;
    startAt: Date;
    endAt: Date;
    sourceMessageId: string;
    sourceChannelId: string;
    createdBy: string;
    status: LeaveNoticeStatus;
    person: { id: string; displayName: string; discordUserId: string };
  }): LeaveRecord {
    return value;
  }

  public async createProposal(input: {
    personId: string;
    startAt: Date;
    endAt: Date;
    sourceMessageId: string;
    sourceChannelId: string;
    createdBy: string;
  }): Promise<LeaveRecord> {
    return PrismaLeaveStore.record(await this.client.leaveNotice.create({
      data: input,
      include: { person: true },
    }));
  }

  public async find(id: string): Promise<LeaveRecord | null> {
    const record = await this.client.leaveNotice.findUnique({ where: { id }, include: { person: true } });
    return record ? PrismaLeaveStore.record(record) : null;
  }

  public async updateTimes(
    id: string,
    actorId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<LeaveRecord> {
    return this.client.$transaction(async (transaction) => {
      const updated = await transaction.leaveNotice.updateMany({
        where: { id, createdBy: actorId, status: LeaveNoticeStatus.PROPOSED },
        data: { startAt, endAt },
      });
      if (updated.count !== 1) throw new ConflictError('請假提案已無法修改');
      return PrismaLeaveStore.record(await transaction.leaveNotice.findUniqueOrThrow({
        where: { id },
        include: { person: true },
      }));
    });
  }

  public async confirm(id: string, actorId: string): Promise<LeaveRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const confirmed = await transaction.leaveNotice.updateMany({
        where: { id, createdBy: actorId, status: LeaveNoticeStatus.PROPOSED },
        data: { status: LeaveNoticeStatus.CONFIRMED },
      });
      if (confirmed.count !== 1) return null;
      return PrismaLeaveStore.record(await transaction.leaveNotice.findUniqueOrThrow({
        where: { id },
        include: { person: true },
      }));
    });
  }

  public async cancel(id: string, actorId: string): Promise<boolean> {
    return (await this.client.leaveNotice.updateMany({
      where: { id, createdBy: actorId, status: LeaveNoticeStatus.PROPOSED },
      data: { status: LeaveNoticeStatus.CANCELLED },
    })).count === 1;
  }

  public async listMorningDue(start: Date, end: Date): Promise<LeaveRecord[]> {
    const records = await this.client.leaveNotice.findMany({
      where: {
        status: LeaveNoticeStatus.CONFIRMED,
        startAt: { gte: start, lt: end },
        morningNotifiedAt: null,
      },
      include: { person: true },
      orderBy: { startAt: 'asc' },
    });
    return records.map((record) => PrismaLeaveStore.record(record));
  }

  public async markMorningNotified(id: string): Promise<boolean> {
    return (await this.client.leaveNotice.updateMany({
      where: { id, status: LeaveNoticeStatus.CONFIRMED, morningNotifiedAt: null },
      data: { morningNotifiedAt: new Date() },
    })).count === 1;
  }
}

export function formatLeaveTime(startAt: Date, endAt: Date): string {
  const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${formatter.format(startAt)} ～ ${formatter.format(endAt)}`;
}

export class LeaveService {
  public constructor(
    private readonly store: LeaveStore,
    private readonly discord: DiscordAdapter,
    private readonly audit?: AuditStore,
  ) {}

  public parse(text: string, now?: Date): ParsedLeave {
    return parseLeaveText(text, now);
  }

  public async propose(input: {
    text: string;
    actorDiscordId: string;
    sourceMessageId: string;
    sourceChannelId: string;
    now?: Date;
  }): Promise<LeaveRecord> {
    const parsed = this.parse(input.text, input.now);
    const person = await this.store.findPerson(input.actorDiscordId, parsed.personHint);
    if (!person) throw new NotFoundError(parsed.personHint
      ? `找不到已綁定的人員「${parsed.personHint}」`
      : '請先用 /bot user-link 綁定 Discord 使用者');
    const record = await this.store.createProposal({
      personId: person.id,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      sourceMessageId: input.sourceMessageId,
      sourceChannelId: input.sourceChannelId,
      createdBy: input.actorDiscordId,
    });
    await this.audit?.append({
      actorType: 'discord_user', actorId: input.actorDiscordId, action: 'leave.propose',
      resourceType: 'leave_notice', resourceId: record.id,
      after: { personId: person.id, startAt: record.startAt, endAt: record.endAt },
      requestId: input.sourceMessageId,
    });
    return record;
  }

  public async findEditable(id: string, actorId: string): Promise<LeaveRecord> {
    const record = await this.store.find(id);
    if (!record || record.createdBy !== actorId || record.status !== LeaveNoticeStatus.PROPOSED) {
      throw new ConflictError('請假提案不存在、已被處理或不屬於目前使用者');
    }
    return record;
  }

  public async confirm(id: string, actorId: string): Promise<LeaveRecord> {
    const record = await this.store.confirm(id, actorId);
    if (!record) throw new ConflictError('請假提案已被處理或不屬於目前使用者');
    await this.discord.sendChannelMessage(
      record.sourceChannelId,
      `📅 請假通知\n\n人員：${record.person.displayName}\n時間：${formatLeaveTime(record.startAt, record.endAt)}`,
    );
    await this.audit?.append({
      actorType: 'discord_user', actorId, action: 'leave.confirm',
      resourceType: 'leave_notice', resourceId: record.id,
      before: { status: LeaveNoticeStatus.PROPOSED }, after: { status: LeaveNoticeStatus.CONFIRMED },
      requestId: id,
    });
    return record;
  }

  public async edit(id: string, actorId: string, start: string, end: string): Promise<LeaveRecord> {
    const before = await this.findEditable(id, actorId);
    const startAt = parseTaipeiDateTime(start);
    const endAt = parseTaipeiDateTime(end);
    if (endAt <= startAt) throw new Error('結束時間必須晚於開始時間');
    const record = await this.store.updateTimes(id, actorId, startAt, endAt);
    await this.audit?.append({
      actorType: 'discord_user', actorId, action: 'leave.edit',
      resourceType: 'leave_notice', resourceId: id,
      before: { startAt: before.startAt, endAt: before.endAt }, after: { startAt, endAt }, requestId: id,
    });
    return record;
  }

  public async cancel(id: string, actorId: string): Promise<void> {
    if (!await this.store.cancel(id, actorId)) throw new ConflictError('請假提案已被處理');
    await this.audit?.append({
      actorType: 'discord_user', actorId, action: 'leave.cancel',
      resourceType: 'leave_notice', resourceId: id,
      before: { status: LeaveNoticeStatus.PROPOSED }, after: { status: LeaveNoticeStatus.CANCELLED },
      requestId: id,
    });
  }

  public async sendMorningNotifications(now = new Date()): Promise<number> {
    const bounds = taipeiDayBounds(now);
    let sent = 0;
    for (const record of await this.store.listMorningDue(bounds.start, bounds.end)) {
      if (!await this.store.markMorningNotified(record.id)) continue;
      await this.discord.sendChannelMessage(
        record.sourceChannelId,
        `☀️ 今日請假提醒\n\n人員：${record.person.displayName}\n時間：${formatLeaveTime(record.startAt, record.endAt)}`,
      );
      await this.audit?.append({
        actorType: 'system', actorId: 'scheduler', action: 'leave.morning_notify',
        resourceType: 'leave_notice', resourceId: record.id,
        after: { notified: true }, requestId: record.id,
      });
      sent += 1;
    }
    return sent;
  }
}
