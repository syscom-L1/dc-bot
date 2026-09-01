import type { AppConfig } from '../config/config.js';
import type { BullQueueSystem } from './queue-system.js';

export class JobScheduler {
  public constructor(
    private readonly queues: BullQueueSystem,
    private readonly config: AppConfig,
    private readonly googleCalendarEnabled = false,
  ) {}

  public async register(): Promise<void> {
    const registrations: Array<Promise<unknown>> = [
      this.queues.queue('daily-report-reminder').upsertJobScheduler(
        'daily-report-reminder-schedule',
        { pattern: this.config.schedules.dailyReportReminder, tz: this.config.timezone },
        { name: 'open', data: {}, opts: { attempts: 3 } },
      ),
      this.queues.queue('daily-summary').upsertJobScheduler(
        'daily-summary-schedule',
        { pattern: this.config.schedules.dailySummary, tz: this.config.timezone },
        { name: 'generate', data: {}, opts: { attempts: 3 } },
      ),
      this.queues.queue('morning-notification').upsertJobScheduler(
        'morning-notification-schedule',
        { pattern: this.config.schedules.morningNotification, tz: this.config.timezone },
        { name: 'notify', data: {}, opts: { attempts: 3 } },
      ),
      this.queues.queue('progress-reminder').upsertJobScheduler(
        'progress-reminder-schedule',
        { pattern: this.config.schedules.reminder, tz: this.config.timezone },
        { name: 'scan', data: {}, opts: { attempts: 3 } },
      ),
      this.queues.queue('weekly-summary').upsertJobScheduler(
        'weekly-summary-schedule',
        { pattern: this.config.schedules.weeklySummary, tz: this.config.timezone },
        { name: 'generate', data: {}, opts: { attempts: 3 } },
      ),
      this.queues.queue('github-reconciliation').upsertJobScheduler(
        'github-reconciliation-schedule',
        { pattern: this.config.schedules.githubReconciliation, tz: this.config.timezone },
        { name: 'reconcile', data: {}, opts: { attempts: 5 } },
      ),
    ];
    if (this.googleCalendarEnabled) {
      registrations.push(this.queues.queue('calendar-notification').upsertJobScheduler(
        'calendar-notification-schedule',
        { pattern: '*/5 * * * *', tz: this.config.timezone },
        { name: 'upcoming', data: {}, opts: { attempts: 3 } },
      ));
    }
    await Promise.all(registrations);
  }
}
