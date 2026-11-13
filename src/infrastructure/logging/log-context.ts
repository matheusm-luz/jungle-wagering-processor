import { AsyncLocalStorage } from 'node:async_hooks';

/** The identifiers statement §12 requires on every log line. All are optional until known. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with its own log context: one per HTTP request, queue message or worker iteration. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Adds identifiers learned along the way. A no-op outside `runWithLogContext`. */
export function addLogContext(fields: LogContext): void {
  const context = storage.getStore();
  if (context) {
    Object.assign(context, fields);
  }
}

export function currentLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? {};
}
