import { describe, expect, it } from 'vitest';
import type { DiscordAdapter } from '../../src/domain/adapters.js';
import type { CalendarEvent, GoogleCalendarAdapter } from '../../src/google/adapters.js';
import { CalendarNotificationService, type CalendarNotificationStore } from '../../src/google/calendar-service.js';

const event: CalendarEvent = {
  id: 'event-1',
  title: 'Daily sync',
  startAt: new Date('2026-08-28T04:15:00.000Z'),
  endAt: new Date('2026-08-28T04:45:00.000Z'),
  allDay: false,
  attendees: ['Alice', 'Bob'],
  link: 'https://meet.google.com/example',
};

class CalendarAdapter implements GoogleCalendarAdapter {
  public async listEvents(): Promise<CalendarEvent[]> { return [event]; }
  public async checkCalendar(): Promise<void> {}
}

class Notifications implements CalendarNotificationStore {
  private claimed = false;
  public async tryClaim(): Promise<boolean> {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
  public async release(): Promise<void> { this.claimed = false; }
}

class Discord implements DiscordAdapter {
  public messages: string[] = [];
  public async sendChannelMessage(_id: string, content: string): Promise<string> {
    this.messages.push(content);
    return String(this.messages.length);
  }
  public async sendDirectMessage(): Promise<string> { return 'dm'; }
  public async checkConnection(): Promise<void> {}
}

describe('Google Calendar notifications', () => {
  it('deduplicates upcoming-event reminders and renders event details', async () => {
    const discord = new Discord();
    const service = new CalendarNotificationService(
      new CalendarAdapter(), new Notifications(), discord, 'calendar-1', 'summary', 15,
    );
    expect(await service.sendUpcoming(new Date('2026-08-28T04:00:00.000Z'))).toBe(1);
    expect(await service.sendUpcoming(new Date('2026-08-28T04:01:00.000Z'))).toBe(0);
    expect(discord.messages[0]).toContain('Daily sync');
    expect(discord.messages[0]).toContain('Alice');
    expect(discord.messages[0]).toContain('meet.google.com');
  });
});
