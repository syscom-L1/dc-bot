import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { DiscordAdapter } from '../domain/adapters.js';
import { splitDiscordMessage } from '../summaries/daily-summary.js';
import type { CalendarEvent, GoogleCalendarAdapter } from './adapters.js';

export interface CalendarNotificationStore {
  tryClaim(calendarId: string, event: CalendarEvent, type: string): Promise<boolean>;
  release(calendarId: string, event: CalendarEvent, type: string): Promise<void>;
}

export class PrismaCalendarNotificationStore implements CalendarNotificationStore {
  public constructor(private readonly client: PrismaClient) {}

  public async tryClaim(calendarId: string, event: CalendarEvent, type: string): Promise<boolean> {
    try {
      await this.client.calendarNotification.create({ data: {
        calendarId,
        eventId: event.id,
        eventStartAt: event.startAt,
        notificationType: type,
      } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
      throw error;
    }
  }

  public async release(calendarId: string, event: CalendarEvent, type: string): Promise<void> {
    await this.client.calendarNotification.deleteMany({
      where: { calendarId, eventId: event.id, eventStartAt: event.startAt, notificationType: type },
    });
  }
}

function taipeiDay(now: Date): { start: Date; end: Date } {
  const local = new Date(now.getTime() + 8 * 3_600_000);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), -8));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function time(event: CalendarEvent): string {
  if (event.allDay) return '全天';
  const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return `${formatter.format(event.startAt)}–${formatter.format(event.endAt)}`;
}

function eventLine(event: CalendarEvent): string {
  const attendees = event.attendees.length > 0 ? `｜參與者：${event.attendees.slice(0, 10).join('、')}` : '';
  const link = event.link ? `｜[連結](<${event.link}>)` : '';
  return `- ${time(event)}｜${event.title}${attendees}${link}`;
}

export class CalendarNotificationService {
  public constructor(
    private readonly calendar: GoogleCalendarAdapter,
    private readonly notifications: CalendarNotificationStore,
    private readonly discord: DiscordAdapter,
    private readonly calendarId: string,
    private readonly channelId: string,
    private readonly reminderMinutes: number,
  ) {}

  public async sendDailySchedule(now = new Date()): Promise<number> {
    if (!this.calendarId || !this.channelId) return 0;
    const bounds = taipeiDay(now);
    const events = await this.calendar.listEvents(this.calendarId, bounds.start, bounds.end);
    const title = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const content = events.length > 0
      ? `📆 ${title} 今日行程\n\n${events.map(eventLine).join('\n')}`
      : `📆 ${title} 今日行程\n\n今天沒有共用 Calendar 活動。`;
    let sent = 0;
    for (const chunk of splitDiscordMessage(content)) {
      await this.discord.sendChannelMessage(this.channelId, chunk);
      sent += 1;
    }
    return sent;
  }

  public async sendUpcoming(now = new Date()): Promise<number> {
    if (!this.calendarId || !this.channelId) return 0;
    const end = new Date(now.getTime() + this.reminderMinutes * 60_000 + 5 * 60_000);
    const events = await this.calendar.listEvents(this.calendarId, now, end);
    let sent = 0;
    for (const event of events.filter((item) => !item.allDay && item.startAt > now)) {
      const type = `before_${this.reminderMinutes}m`;
      if (!await this.notifications.tryClaim(this.calendarId, event, type)) continue;
      try {
        await this.discord.sendChannelMessage(
          this.channelId,
          `⏰ 行程即將開始\n\n${eventLine(event).slice(2)}`,
        );
        sent += 1;
      } catch (error) {
        await this.notifications.release(this.calendarId, event, type);
        throw error;
      }
    }
    return sent;
  }
}
