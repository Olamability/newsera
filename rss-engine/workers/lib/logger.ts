/**
 * Phase B queue-runner — structured JSON logger.
 *
 * Intentionally tiny: one function, one shape. Mirrors the contract used by
 * the existing `rss-worker.ts` so a single log pipeline can consume both.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  service: string;
  worker_id: string;
}

export type LogFn = (
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export function createLogger(ctx: LogContext): LogFn {
  return function log(level, message, fields = {}) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      service: ctx.service,
      worker_id: ctx.worker_id,
      msg: message,
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  };
}
