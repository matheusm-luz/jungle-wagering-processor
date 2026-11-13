import type { LoggerService } from '@nestjs/common';
import type { JsonLogger, LogFields } from './json-logger';

/**
 * Routes the lines NestJS writes itself (bootstrap, unhandled exceptions) through `JsonLogger`,
 * so the process never emits a non-JSON line. NestJS passes the logger context as the last
 * string argument and, for errors, the stack before it.
 */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: JsonLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(text(message), { context: lastString(params) });
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(text(message), { context: lastString(params) });
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(text(message), { context: lastString(params) });
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.debug(message, ...params);
  }

  error(message: unknown, ...params: unknown[]): void {
    const strings = params.filter((param): param is string => typeof param === 'string');
    const fields: LogFields = {
      context: strings.at(-1),
      stack: strings.length > 1 ? strings[0] : undefined,
    };
    if (message instanceof Error) {
      this.logger.error(message.message, fields, message);
    } else {
      this.logger.error(text(message), fields);
    }
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.error(message, ...params);
  }
}

function text(message: unknown): string {
  return typeof message === 'string' ? message : String(message);
}

function lastString(params: unknown[]): string | undefined {
  const last = params.at(-1);
  return typeof last === 'string' ? last : undefined;
}
