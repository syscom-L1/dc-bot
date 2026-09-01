import type { WorkItem } from '../domain/models.js';

export interface RiskRules {
  dueSoonDays: number;
  inactivityHours: number;
  reviewWaitHours: number;
}

export type WorkItemRisk =
  | { type: 'overdue'; ageHours: number }
  | { type: 'due_soon_inactive'; hoursUntilDue: number; inactiveHours: number }
  | { type: 'review_waiting'; waitingHours: number };

const hours = (milliseconds: number): number => milliseconds / 3_600_000;

export function evaluateWorkItemRisks(
  item: WorkItem,
  now: Date,
  rules: RiskRules,
): WorkItemRisk[] {
  if (item.state !== 'open') return [];
  const risks: WorkItemRisk[] = [];
  const inactiveHours = hours(now.getTime() - item.updatedAt.getTime());

  if (item.targetDate) {
    const hoursUntilDue = hours(item.targetDate.getTime() - now.getTime());
    if (hoursUntilDue < 0) {
      risks.push({ type: 'overdue', ageHours: Math.abs(hoursUntilDue) });
    } else if (hoursUntilDue <= rules.dueSoonDays * 24 && inactiveHours >= rules.inactivityHours) {
      risks.push({ type: 'due_soon_inactive', hoursUntilDue, inactiveHours });
    }
  }

  if (
    item.type === 'pull_request'
    && item.reviewState === 'pending'
    && inactiveHours >= rules.reviewWaitHours
  ) {
    risks.push({ type: 'review_waiting', waitingHours: inactiveHours });
  }
  return risks;
}
