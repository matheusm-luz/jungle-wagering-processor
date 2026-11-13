import { currentLogContext } from './log-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogLevelThreshold = LogLevel | 'silent';

/**
 * Fields are flat primitives on purpose: an object cannot be passed, so a request body or a
 * financial payload cannot end up in a log line by accident.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface JsonLoggerOptions {
  level: LogLevelThreshold;
  /** Defaults to stdout. */
  write?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
}

const SEVERITY: Record<LogLevelThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

export class JsonLogger {
  private readonly threshold: number;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: JsonLoggerOptions) {
    this.threshold = SEVERITY[options.level];
    this.write = options.write ?? ((line) => void process.stdout.write(line));
    this.now = options.now ?? (() => new Date());
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields?: LogFields, cause?: unknown): void {
    this.emit('error', message, cause === undefined ? fields : { ...fields, ...describe(cause) });
  }

  private emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (SEVERITY[level] < this.threshold) {
      return;
    }
    const head = { level, time: this.now().toISOString(), message };
    // `head` goes first for position and last so no field can replace level, time or message.
    const record = Object.assign({}, head, currentLogContext(), fields, head);
    this.write(`${JSON.stringify(record)}\n`);
  }
}

function describe(cause: unknown): LogFields {
  if (cause instanceof Error) {
    return { errorName: cause.name, errorMessage: cause.message, stack: cause.stack };
  }
  return { errorName: 'NonError', errorMessage: String(cause) };
}
