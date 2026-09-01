import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../../src/domain/models.js';
import { evaluateWorkItemRisks } from '../../src/github/rules.js';

const now = new Date('2026-08-28T04:00:00.000Z');

function issue(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    providerItemId: 'I_1',
    type: 'issue',
    owner: 'acme',
    repository: 'api',
    number: 42,
    title: 'Ship vertical slice',
    url: 'https://github.com/acme/api/issues/42',
    state: 'open',
    assignees: ['alice'],
    updatedAt: new Date('2026-08-25T00:00:00.000Z'),
    ...overrides,
  };
}

const rules = { dueSoonDays: 3, inactivityHours: 48, reviewWaitHours: 24 };

describe('evaluateWorkItemRisks', () => {
  it('finds due-soon inactive issues', () => {
    const risks = evaluateWorkItemRisks(issue({ targetDate: new Date('2026-08-30T15:59:59.999Z') }), now, rules);
    expect(risks.some((risk) => risk.type === 'due_soon_inactive')).toBe(true);
  });

  it('finds overdue issues and ignores closed ones', () => {
    const targetDate = new Date('2026-08-27T15:59:59.999Z');
    expect(evaluateWorkItemRisks(issue({ targetDate }), now, rules)).toContainEqual(expect.objectContaining({ type: 'overdue' }));
    expect(evaluateWorkItemRisks(issue({ targetDate, state: 'closed' }), now, rules)).toEqual([]);
  });

  it('finds pull requests waiting too long for review', () => {
    const risks = evaluateWorkItemRisks(issue({ type: 'pull_request', reviewState: 'pending' }), now, rules);
    expect(risks).toContainEqual(expect.objectContaining({ type: 'review_waiting' }));
  });
});
