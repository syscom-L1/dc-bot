import { z } from 'zod';

const serviceAccountSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
});

const envSchema = z.object({
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(''),
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().default(''),
  GOOGLE_CALENDAR_ID: z.string().default(''),
  GOOGLE_CALENDAR_REMINDER_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
});

export interface GoogleConfig {
  enabled: boolean;
  credentials?: z.infer<typeof serviceAccountSchema>;
  calendarId: string;
  reminderMinutes: number;
}

export function loadGoogleConfig(source: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const env = envSchema.parse(source);
  const encoded = env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const raw = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return { enabled: false, calendarId: env.GOOGLE_CALENDAR_ID, reminderMinutes: env.GOOGLE_CALENDAR_REMINDER_MINUTES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON', { cause: error });
  }
  return {
    enabled: true,
    credentials: serviceAccountSchema.parse(parsed),
    calendarId: env.GOOGLE_CALENDAR_ID,
    reminderMinutes: env.GOOGLE_CALENDAR_REMINDER_MINUTES,
  };
}
