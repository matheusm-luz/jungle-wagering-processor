import { describe, expect, test } from 'bun:test';
import { CheckConstraintViolationException, DriverException } from '@mikro-orm/core';
import type { ArgumentsHost } from '@nestjs/common';
import { ProviderForbiddenError } from '../../../src/application/errors';
import { ErrorFilter } from '../../../src/infrastructure/http/error.filter';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';

/** A row PostgreSQL quotes in a CHECK violation's detail: it must never reach a log line. */
const FAILING_ROW = 'Failing row contains (player-secret-7, 98765.43, BRL)';

function capture(exception: unknown) {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    level: 'debug',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const answer: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const response = {
    status(code: number) {
      answer.status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      answer.headers[name] = value;
      return response;
    },
    json(body: unknown) {
      answer.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new ErrorFilter(logger).catch(exception, host);
  return { answer, lines };
}

describe('ErrorFilter on driver errors (S6 review m2, S12 review)', () => {
  test('a non-transient driver error is a generic 500 whose log has the name, code and constraint only', () => {
    const exception = new CheckConstraintViolationException(
      Object.assign(new Error(`new row violates check constraint\n - detail: ${FAILING_ROW}`), {
        code: '23514',
        constraint: 'wallets_balance_non_negative',
      }) as unknown as Error,
    );

    const { answer, lines } = capture(exception);

    expect(answer).toEqual({
      status: 500,
      body: { statusCode: 500, message: 'Internal server error' },
      headers: {},
    });
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'error',
        message: 'request failed',
        errorName: 'CheckConstraintViolationException',
        errorCode: '23514',
        constraint: 'wallets_balance_non_negative',
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('player-secret-7');
    expect(JSON.stringify(lines)).not.toContain('98765.43');
  });

  test('a transient driver error is a 503 with Retry-After and no driver message in the log', () => {
    const exception = new DriverException(
      Object.assign(new Error(`canceling statement due to lock timeout ${FAILING_ROW}`), {
        code: '55P03',
      }),
    );

    const { answer, lines } = capture(exception);

    expect(answer).toMatchObject({
      status: 503,
      body: { code: 'SERVICE_UNAVAILABLE' },
      headers: { 'Retry-After': '1' },
    });
    expect(lines).toEqual([
      expect.objectContaining({ level: 'warn', errorCode: '55P03', errorName: 'DriverException' }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('player-secret-7');
  });

  test('PROVIDER_FORBIDDEN is 403 (ADR-08)', () => {
    const { answer } = capture(new ProviderForbiddenError());

    expect(answer).toMatchObject({ status: 403, body: { code: 'PROVIDER_FORBIDDEN' } });
  });
});
