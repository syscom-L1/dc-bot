import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { DailyReportReminderService, DailyReportSummaryService } from '../daily-reports/daily-report-service.js';
import type { WeeklySummaryService } from '../summaries/weekly-summary.js';
import type { ProgressReminderService } from '../reminders/reminder-service.js';
import type { LeaveService } from '../leave/leave-service.js';
import type { GitHubWebhookProcessor } from '../github/webhook-processor.js';
import type { GitHubWebhookJob } from '../github/webhook-service.js';
import type { GitHubReconciliationService } from '../github/reconciliation.js';
import type { CalendarNotificationService } from '../google/calendar-service.js';
import type { MonitoringAlertProcessor } from '../monitoring/webhook-service.js';
import type { AiNewsDigestService } from '../ai-news/digest-service.js';
import type { AiNewsLinkSummaryService } from '../ai-news/link-summary-service.js';
import type { BullQueueSystem, QueueName } from './queue-system.js';

const monitoringJobSchema = z.object({ deliveryId: z.string().min(1), payload: z.unknown() });
const projectJobSchema = z.object({ projectBindingId: z.string().uuid().optional() }).passthrough();
const aiNewsDigestJobSchema = z.object({
	guildId: z.string().min(1).optional(),
	preview: z.boolean().optional().default(false),
});
const aiNewsLinkJobSchema = z.object({
	guildId: z.string().min(1),
	channelId: z.string().min(1),
	messageId: z.string().min(1),
	userId: z.string().min(1),
	urls: z.array(z.string().url()).min(1).max(3),
});

const githubJobSchema = z.object({
  deliveryId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.unknown(),
});

export class WorkerSystem {
  private readonly workers: Worker[] = [];

  public constructor(
    private readonly queues: BullQueueSystem,
    private readonly webhookProcessor: GitHubWebhookProcessor,
    private readonly dailyReportReminder: DailyReportReminderService,
    private readonly dailyReportSummary: DailyReportSummaryService,
    private readonly weeklySummary: WeeklySummaryService,
    private readonly reminders: ProgressReminderService,
    private readonly reconciliation: GitHubReconciliationService,
    private readonly leaves: LeaveService,
    private readonly calendar: CalendarNotificationService | undefined,
    private readonly monitoring: MonitoringAlertProcessor | undefined,
    private readonly aiNews: {
		digest: AiNewsDigestService;
		linkSummary: AiNewsLinkSummaryService;
		notifyFailure?: (message: string) => Promise<void>;
	} | undefined,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    this.createWorker('github-webhook', async (job) => {
      const parsed = githubJobSchema.parse(job.data);
      const data: GitHubWebhookJob = {
        deliveryId: parsed.deliveryId,
        eventType: parsed.eventType,
        payload: parsed.payload,
      };
      await this.webhookProcessor.process(data);
    });
    this.createWorker('daily-report-reminder', async (job) => {
      const { projectBindingId } = projectJobSchema.parse(job.data);
      await this.dailyReportReminder.run(new Date(), projectBindingId);
    });
    this.createWorker('daily-summary', async (job) => {
      const { projectBindingId } = projectJobSchema.parse(job.data);
      await this.dailyReportSummary.run(new Date(), projectBindingId);
    });
    this.createWorker('morning-notification', async () => {
      await this.leaves.sendMorningNotifications();
      if (this.calendar) await this.calendar.sendDailySchedule();
    });
    this.createWorker('weekly-summary', async () => {
      await this.weeklySummary.run();
    });
    this.createWorker('progress-reminder', async () => {
      await this.reminders.run();
    });
    this.createWorker('github-reconciliation', async () => {
      await this.reconciliation.run();
    });
    if (this.calendar) {
      this.createWorker('calendar-notification', async () => {
        await this.calendar?.sendUpcoming();
      });
    }
    if (this.monitoring) {
      this.createWorker('monitoring-alert', async (job) => {
        const parsed = monitoringJobSchema.parse(job.data);
        await this.monitoring?.process({ deliveryId: parsed.deliveryId, payload: parsed.payload });
      });
    }
		if (this.aiNews) {
			this.createWorker('ai-news-digest', async (job) => {
				const parsed = aiNewsDigestJobSchema.parse(job.data);
				await this.aiNews?.digest.run(new Date(), parsed.guildId, parsed.preview);
			});
			this.createWorker('ai-news-link-summary', async (job) => {
				await this.aiNews?.linkSummary.run(aiNewsLinkJobSchema.parse(job.data));
			});
		}
  }

  private createWorker(name: QueueName, processor: (job: Job) => Promise<void>): void {
    const worker = new Worker(name, processor, {
      connection: this.queues.connection,
      concurrency: name === 'github-webhook' ? 10 : 1,
      lockDuration: 60_000,
    });
    worker.on('completed', (job) => this.logger.info({ queue: name, jobId: job.id }, 'job completed'));
    worker.on('failed', (job, error) => {
      this.logger.error({ queue: name, jobId: job?.id, err: error }, 'job failed');
      const failedData: unknown = job?.data;
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.queues.queue('dead-letter').add(
          'dead-letter',
          { originalJobId: job.id, originalName: job.name, data: failedData, error: error.message },
          { jobId: `dead-letter-${job.id ?? 'unknown'}`, attempts: 1 },
        );
				if (name === 'ai-news-digest' && this.aiNews?.notifyFailure) {
					void this.aiNews.notifyFailure(`AI 新聞早報已用完重試次數，請檢查 Worker 與來源狀態。Job ID：${job.id ?? 'unknown'}`)
						.catch((notifyError: unknown) => this.logger.error({ err: notifyError, jobId: job.id }, 'AI news failure notification failed'));
				}
      }
    });
    worker.on('error', (error) => this.logger.error({ queue: name, err: error }, 'worker error'));
    this.workers.push(worker);
  }

  public async close(): Promise<void> {
    await Promise.all(this.workers.map(async (worker) => worker.close()));
  }
}
