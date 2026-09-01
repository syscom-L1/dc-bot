import pino, { type Logger } from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.x-hub-signature-256',
  'headers.authorization',
  'headers.x-hub-signature-256',
  '*.token',
  '*.apiKey',
  '*.privateKey',
  '*.password',
  'config.databaseUrl',
  'config.redisUrl',
];

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
