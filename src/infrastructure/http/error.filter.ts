import { type ArgumentsHost, BadRequestException, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { RequestValidationError } from './request-validation.error';

/** ARCHITECTURE §6: the status of each outcome that is answered without being persisted. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_ERROR: 400,
  WALLET_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
};

export interface ErrorResponse {
  code: string;
  message: string;
}

/**
 * Answers application and validation errors as `{ code, message }` with the status of
 * ARCHITECTURE §6. A body that is not valid JSON is a `VALIDATION_ERROR` too. Everything else goes
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
    // Raised by the JSON body parser; its message would echo part of the body, so it is replaced.
    if (exception instanceof BadRequestException && isBodyParseError(exception)) {
      return [400, { code: 'VALIDATION_ERROR', message: 'Body is not valid JSON' }];
    }
    return undefined;
  }
}

function isBodyParseError(exception: HttpException): boolean {
  const cause = exception.cause as { type?: string } | undefined;
  return cause?.type === 'entity.parse.failed' || exception.message.includes('JSON');
}
