import { describe, expect, it } from 'vitest';
import { parseLeaveText, parseTaipeiDateTime, taipeiDayBounds } from '../../src/leave/leave-parser.js';

const now = new Date('2026-08-28T03:00:00.000Z'); // 2026-08-28 11:00 Asia/Taipei

describe('Taipei leave parser', () => {
  it('parses tomorrow as a full working day for the author', () => {
    const parsed = parseLeaveText('我明天請假一天', now);
    expect(parsed.personHint).toBeNull();
    expect(parsed.startAt.toISOString()).toBe('2026-08-29T01:00:00.000Z');
    expect(parsed.endAt.toISOString()).toBe('2026-08-29T10:00:00.000Z');
  });

  it('parses an explicit person and afternoon window', () => {
    const parsed = parseLeaveText('小明 8/29 下午請假', now);
    expect(parsed.personHint).toBe('小明');
    expect(parsed.startAt.toISOString()).toBe('2026-08-29T05:30:00.000Z');
    expect(parsed.endAt.toISOString()).toBe('2026-08-29T09:30:00.000Z');
  });

  it('parses next Monday morning', () => {
    const parsed = parseLeaveText('我下週一早上不在', now);
    expect(parsed.startAt.toISOString()).toBe('2026-08-31T01:00:00.000Z');
    expect(parsed.endAt.toISOString()).toBe('2026-08-31T04:30:00.000Z');
  });

  it('validates editable date-time values and day bounds', () => {
    expect(parseTaipeiDateTime('2026-08-29 13:30').toISOString()).toBe('2026-08-29T05:30:00.000Z');
    expect(() => parseTaipeiDateTime('2026-02-30 09:00')).toThrow();
    const bounds = taipeiDayBounds(now);
    expect(bounds.start.toISOString()).toBe('2026-08-27T16:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-08-28T16:00:00.000Z');
  });
});
