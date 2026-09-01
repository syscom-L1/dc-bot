import { google, type calendar_v3, type docs_v1 } from 'googleapis';
import { z } from 'zod';
import type { GoogleConfig } from '../config/google-config.js';

export interface DocumentSpan {
  startIndex: number;
  endIndex: number;
  text: string;
  headingLevel?: number;
}

export interface GoogleDocumentSnapshot {
  documentId: string;
  title: string;
  revisionId: string;
  spans: DocumentSpan[];
  namedRanges: Record<string, Array<{ startIndex: number; endIndex: number }>>;
}

export const documentTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('named_range'), value: z.string().min(1) }),
  z.object({ type: z.literal('heading'), value: z.string().min(1) }),
  z.object({ type: z.literal('marker'), value: z.string().min(1) }),
  z.object({ type: z.literal('append'), value: z.literal('end') }),
]);

export type DocumentTarget = z.infer<typeof documentTargetSchema>;

export interface LocatedDocumentTarget {
  startIndex: number;
  endIndex: number;
  before: string;
}

export interface GoogleDocumentEdit {
  documentId: string;
  revisionId: string;
  mode: 'comment' | 'insert' | 'replace';
  target: DocumentTarget;
  content: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  attendees: string[];
  link?: string;
}

export interface GoogleDocsAdapter {
  readDocument(documentId: string): Promise<GoogleDocumentSnapshot>;
  locate(snapshot: GoogleDocumentSnapshot, target: DocumentTarget): LocatedDocumentTarget;
  applyEdit(edit: GoogleDocumentEdit): Promise<{ revisionId?: string; commentId?: string }>;
  checkConnection(documentId?: string): Promise<void>;
}

export interface GoogleCalendarAdapter {
  listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  checkCalendar(calendarId: string): Promise<void>;
}

function headingLevel(namedStyleType: string | null | undefined): number | undefined {
  const match = namedStyleType?.match(/^HEADING_(\d)$/u);
  return match ? Number(match[1]) : undefined;
}

function paragraphText(paragraph: docs_v1.Schema$Paragraph): string {
  return paragraph.elements?.map((element) => element.textRun?.content ?? '').join('') ?? '';
}

function namedRanges(document: docs_v1.Schema$Document): GoogleDocumentSnapshot['namedRanges'] {
  const output: GoogleDocumentSnapshot['namedRanges'] = {};
  for (const [name, value] of Object.entries(document.namedRanges ?? {})) {
    output[name] = (value.namedRanges ?? []).flatMap((range) => (
      range.ranges ?? []
    )).flatMap((range) => (
      range.startIndex === null || range.startIndex === undefined || range.endIndex === null || range.endIndex === undefined
        ? []
        : [{ startIndex: range.startIndex, endIndex: range.endIndex }]
    ));
  }
  return output;
}

function spanText(snapshot: GoogleDocumentSnapshot, startIndex: number, endIndex: number): string {
  return snapshot.spans
    .filter((span) => span.endIndex > startIndex && span.startIndex < endIndex)
    .map((span) => span.text)
    .join('')
    .trim();
}

function parseEventDate(value: calendar_v3.Schema$EventDateTime | undefined): { date: Date; allDay: boolean } | null {
  if (value?.dateTime) return { date: new Date(value.dateTime), allDay: false };
  if (value?.date) return { date: new Date(`${value.date}T00:00:00+08:00`), allDay: true };
  return null;
}

export class GoogleWorkspaceAdapter implements GoogleDocsAdapter, GoogleCalendarAdapter {
  private readonly docs: docs_v1.Docs;
  private readonly drive: ReturnType<typeof google.drive>;
  private readonly calendar: calendar_v3.Calendar;

  public constructor(config: GoogleConfig) {
    if (!config.enabled || !config.credentials) throw new Error('Google Workspace integration is disabled');
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: config.credentials.client_email,
        private_key: config.credentials.private_key,
        ...(config.credentials.project_id ? { project_id: config.credentials.project_id } : {}),
      },
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/calendar.readonly',
      ],
    });
    this.docs = google.docs({ version: 'v1', auth });
    this.drive = google.drive({ version: 'v3', auth });
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  public async readDocument(documentId: string): Promise<GoogleDocumentSnapshot> {
    const response = await this.docs.documents.get({
      documentId,
      suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
    });
    const revisionId = response.data.revisionId;
    if (!revisionId) throw new Error('Google Docs response did not include a revision ID');
    const spans: DocumentSpan[] = [];
    for (const item of response.data.body?.content ?? []) {
      if (!item.paragraph || item.startIndex === null || item.startIndex === undefined || item.endIndex === null || item.endIndex === undefined) continue;
      const text = paragraphText(item.paragraph);
      if (!text) continue;
      const span: DocumentSpan = { startIndex: item.startIndex, endIndex: item.endIndex, text };
      const level = headingLevel(item.paragraph.paragraphStyle?.namedStyleType);
      if (level) span.headingLevel = level;
      spans.push(span);
    }
    return {
      documentId,
      title: response.data.title ?? documentId,
      revisionId,
      spans,
      namedRanges: namedRanges(response.data),
    };
  }

  public locate(snapshot: GoogleDocumentSnapshot, target: DocumentTarget): LocatedDocumentTarget {
    if (target.type === 'named_range') {
      const range = snapshot.namedRanges[target.value]?.[0];
      if (!range) throw new Error(`Allowed Google Docs named range not found: ${target.value}`);
      return { ...range, before: spanText(snapshot, range.startIndex, range.endIndex) };
    }
    if (target.type === 'marker') {
      for (const span of snapshot.spans) {
        const offset = span.text.indexOf(target.value);
        if (offset >= 0) {
          return {
            startIndex: span.startIndex + offset,
            endIndex: span.startIndex + offset + target.value.length,
            before: target.value,
          };
        }
      }
      throw new Error(`Google Docs marker not found: ${target.value}`);
    }
    if (target.type === 'heading') {
      const index = snapshot.spans.findIndex((span) => span.headingLevel && span.text.trim() === target.value.trim());
      const heading = snapshot.spans[index];
      const level = heading?.headingLevel;
      if (!heading || !level) throw new Error('Google Docs heading not found: ' + target.value);
      const next = snapshot.spans.slice(index + 1).find((span) => span.headingLevel && span.headingLevel <= level);
      const documentEnd = snapshot.spans.at(-1)?.endIndex ?? heading.endIndex;
      const startIndex = heading.endIndex;
      const endIndex = next?.startIndex ?? Math.max(startIndex, documentEnd - 1);
      return { startIndex, endIndex, before: spanText(snapshot, startIndex, endIndex) };
    }
    const end = Math.max(1, (snapshot.spans.at(-1)?.endIndex ?? 2) - 1);
    return { startIndex: end, endIndex: end, before: '' };
  }

  public async applyEdit(edit: GoogleDocumentEdit): Promise<{ revisionId?: string; commentId?: string }> {
    if (edit.mode === 'comment') {
      const response = await this.drive.comments.create({
        fileId: edit.documentId,
        fields: 'id',
        requestBody: { content: edit.content },
      });
      return response.data.id ? { commentId: response.data.id } : {};
    }
    const snapshot = await this.readDocument(edit.documentId);
    if (snapshot.revisionId !== edit.revisionId) {
      throw new Error('Google document changed after preview; generate a new diff before writing');
    }
    const located = this.locate(snapshot, edit.target);
    const requests: docs_v1.Schema$Request[] = [];
    if (edit.mode === 'replace' && located.endIndex > located.startIndex) {
      requests.push({ deleteContentRange: { range: { startIndex: located.startIndex, endIndex: located.endIndex } } });
    }
    const insertionIndex = edit.mode === 'insert' ? located.endIndex : located.startIndex;
    requests.push({ insertText: { location: { index: insertionIndex }, text: `${edit.content}\n` } });
    const response = await this.docs.documents.batchUpdate({
      documentId: edit.documentId,
      requestBody: {
        requests,
        writeControl: { requiredRevisionId: edit.revisionId },
      },
    });
    return response.data.writeControl?.requiredRevisionId
      ? { revisionId: response.data.writeControl.requiredRevisionId }
      : {};
  }

  public async checkConnection(documentId?: string): Promise<void> {
    if (!documentId) return;
    await this.docs.documents.get({ documentId, fields: 'documentId,revisionId' });
  }

  public async listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
    const response = await this.calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });
    return (response.data.items ?? []).flatMap((event): CalendarEvent[] => {
      const start = parseEventDate(event.start);
      const end = parseEventDate(event.end);
      if (!event.id || !start || !end || event.status === 'cancelled') return [];
      const result: CalendarEvent = {
        id: event.id,
        title: event.summary ?? '(無標題)',
        startAt: start.date,
        endAt: end.date,
        allDay: start.allDay,
        attendees: (event.attendees ?? []).flatMap((attendee) => attendee.displayName ?? attendee.email ?? []),
      };
      const link = event.hangoutLink ?? event.htmlLink ?? event.location;
      if (link) result.link = link;
      return [result];
    });
  }

  public async checkCalendar(calendarId: string): Promise<void> {
    await this.calendar.calendars.get({ calendarId });
  }
}
