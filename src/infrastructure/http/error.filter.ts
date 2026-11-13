import { type ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { RequestValidationError } from './request-validation.error';

/** ARCHITECTURE §6: the status of each outcome that is answered without being persisted. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  WALLET_NOT_FOUND: 404,
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
 * 500 that reveals nothing.
 */
@Catch()
export class ErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const answer = this.answer(exception);
    if (answer === undefined) {
      super.catch(exception, host);
      return;
    }
    const [status, body] = answer;
    host.switchToHttp().getResponse<Response>().status(status).json(body);
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
