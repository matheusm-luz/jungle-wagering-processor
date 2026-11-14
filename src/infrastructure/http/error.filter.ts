import { DriverException } from '@mikro-orm/core';
import { type ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { JsonLogger } from '../logging/json-logger';
import { isTransientDatabaseError } from '../persistence/transient-errors';
import { RequestValidationError } from './request-validation.error';

/**
 * ADR-05: the same request may be resent at once with the same key. Usually nothing was committed;
 * if the connection dropped during COMMIT and the server committed, the resend replays the result.
 * `POST /wallets` has no key: there the resend of a committed opening is 409 WALLET_ALREADY_EXISTS.
 */
const RETRY_AFTER_S = '1';

/** ARCHITECTURE §6: the status of each outcome that is answered without being persisted. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  PROVIDER_FORBIDDEN: 403,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
};

export interface ErrorResponse {
  code: string;
  message: string;
}

/**
 * Answers application and validation errors as `{ code, message }` with the status of
 * ARCHITECTURE §6. A body that is not valid JSON, or a path that cannot be decoded, is a
 * `VALIDATION_ERROR` too. Everything else goes
 * to Nest's default handling, so health checks keep their own body and an unexpected error is a
 * 500 that reveals nothing. A transient database failure (lock or statement timeout, pool
 * exhausted, connection lost) is a 503 with `Retry-After` (ADR-05).
 */
@Catch()
export class ErrorFilter extends BaseExceptionFilter {
  constructor(private readonly logger: JsonLogger) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (isTransientDatabaseError(exception)) {
      this.logger.warn('request failed, service unavailable', safeFields(exception));
      response.status(503).setHeader('Retry-After', RETRY_AFTER_S);
      response.json({ code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable, retry later' });
      return;
    }
    // Nest would log the message, and PostgreSQL's detail in it is the failing row (S6 review, m2).
    if (exception instanceof DriverException) {
      this.logger.error('request failed', safeFields(exception));
      response.status(500).json({ statusCode: 500, message: 'Internal server error' });
      return;
    }
    const answer = this.answer(exception);
    if (answer === undefined) {
      super.catch(exception, host);
      return;
    }
    const [status, body] = answer;
    response.status(status).json(body);
  }

  private answer(exception: unknown): [number, ErrorResponse] | undefined {
    if (exception instanceof ApplicationError || exception instanceof RequestValidationError) {
      const status = STATUS_BY_CODE[exception.code];
      if (status !== undefined) {
        return [status, { code: exception.code, message: exception.message }];
      }
    }
    // Nest's Express adapter wraps exactly two request errors of status 400 this way: a body that
    // is not valid JSON (SyntaxError) and a path parameter with invalid percent-encoding (URIError).
    // Their messages echo part of the request, so a generic one replaces them.
    if (
      exception instanceof BadRequestException &&
      (exception.cause instanceof SyntaxError || exception.cause instanceof URIError)
    ) {
      return [400, { code: 'VALIDATION_ERROR', message: 'Invalid request' }];
    }
    return undefined;
  }
}

/** What a driver error may log: its class, code (SQLSTATE or socket) and constraint, never its message. */
function safeFields(error: unknown): Record<string, string> {
  const { name, code, constraint } = error as {
    name?: unknown;
    code?: unknown;
    constraint?: unknown;
  };
  const fields: Record<string, string> = {
    errorName: error instanceof Error && typeof name === 'string' ? name : 'NonError',
  };
  if (typeof code === 'string') fields.errorCode = code;
  if (typeof constraint === 'string') fields.constraint = constraint;
  return fields;
}
