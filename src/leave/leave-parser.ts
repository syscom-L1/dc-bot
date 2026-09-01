export interface ParsedLeave {
  personHint: string | null;
  startAt: Date;
  endAt: Date;
}

const taipeiOffsetMs = 8 * 60 * 60 * 1_000;

function localParts(at: Date): { year: number; month: number; day: number; weekday: number } {
  const local = new Date(at.getTime() + taipeiOffsetMs);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    weekday: local.getUTCDay(),
  };
}

function localDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  const value = new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
  const parts = localParts(value);
  if (parts.year !== year || parts.month !== month || parts.day !== day) {
    throw new Error('請假日期無效');
  }
  return value;
}

function addLocalDays(input: { year: number; month: number; day: number }, days: number) {
  const noonUtc = new Date(Date.UTC(input.year, input.month - 1, input.day + days, 4));
  return localParts(noonUtc);
}

function resolveDate(text: string, now: Date): { year: number; month: number; day: number; marker: string } {
  const today = localParts(now);
  if (text.includes('明天')) return { ...addLocalDays(today, 1), marker: '明天' };
  if (text.includes('後天') || text.includes('后天')) return { ...addLocalDays(today, 2), marker: text.includes('後天') ? '後天' : '后天' };
  if (text.includes('今天')) return { ...today, marker: '今天' };

  const nextWeek = text.match(/下[週周]([一二三四五六日天])/u);
  if (nextWeek) {
    const target = '一二三四五六日'.indexOf(nextWeek[1] === '天' ? '日' : nextWeek[1] ?? '') + 1;
    const isoWeekday = today.weekday === 0 ? 7 : today.weekday;
    const date = addLocalDays(today, 8 - isoWeekday + target - 1);
    return { ...date, marker: nextWeek[0] };
  }

  const slash = text.match(/(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})/u);
  const chinese = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?/u);
  const match = slash ?? chinese;
  if (!match) throw new Error('無法辨識請假日期，請使用「明天」、「下週一」或 YYYY/MM/DD');
  const hasYear = Boolean(match[1]);
  let year = match[1] ? Number(match[1]) : today.year;
  const month = Number(match[2]);
  const day = Number(match[3]);
  let candidate = localDate(year, month, day, 12, 0);
  const todayStart = localDate(today.year, today.month, today.day, 0, 0);
  if (!hasYear && candidate < todayStart) {
    year += 1;
    candidate = localDate(year, month, day, 12, 0);
  }
  void candidate;
  return { year, month, day, marker: match[0] };
}

function resolveTime(text: string): { startHour: number; startMinute: number; endHour: number; endMinute: number } {
  if (/(下午|午後)/u.test(text)) return { startHour: 13, startMinute: 30, endHour: 17, endMinute: 30 };
  if (/(早上|上午)/u.test(text)) return { startHour: 9, startMinute: 0, endHour: 12, endMinute: 30 };
  if (/(晚上|晚間)/u.test(text)) return { startHour: 18, startMinute: 0, endHour: 22, endMinute: 0 };
  return { startHour: 9, startMinute: 0, endHour: 18, endMinute: 0 };
}

function personHint(text: string, marker: string): string | null {
  const before = text.slice(0, text.indexOf(marker)).trim();
  if (!before || before === '我' || before.endsWith('我')) return null;
  const candidate = before.split(/\s+/u).at(-1)?.replace(/[，,：:]/gu, '');
  return candidate && candidate !== '我' ? candidate.slice(0, 100) : null;
}

export function parseLeaveText(text: string, now = new Date()): ParsedLeave {
  if (!/(請假|休假|不在)/u.test(text)) throw new Error('訊息不是請假通知');
  const date = resolveDate(text, now);
  const time = resolveTime(text);
  const startAt = localDate(date.year, date.month, date.day, time.startHour, time.startMinute);
  const endAt = localDate(date.year, date.month, date.day, time.endHour, time.endMinute);
  if (endAt <= startAt) throw new Error('請假結束時間必須晚於開始時間');
  return { personHint: personHint(text, date.marker), startAt, endAt };
}

export function parseTaipeiDateTime(value: string): Date {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/u);
  if (!match) throw new Error('請使用 YYYY-MM-DD HH:mm 格式');
  return localDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

export function taipeiDayBounds(now: Date): { start: Date; end: Date } {
  const today = localParts(now);
  return {
    start: localDate(today.year, today.month, today.day, 0, 0),
    end: localDate(...Object.values(addLocalDays(today, 1)).slice(0, 3) as [number, number, number], 0, 0),
  };
}
