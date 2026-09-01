import type { Logger } from 'pino';

export interface Closeable {
  close(): unknown;
}

export function installGracefulShutdown(logger: Logger, closeables: Closeable[]): void {
  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'graceful shutdown started');
    const results = await Promise.allSettled(closeables.map((item) => Promise.resolve(item.close())));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      logger.error({ failed }, 'graceful shutdown had failures');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
