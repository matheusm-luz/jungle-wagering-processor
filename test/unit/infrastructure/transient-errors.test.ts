import { describe, expect, test } from 'bun:test';
import {
  CheckConstraintViolationException,
  DriverException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import { isTransientDatabaseError } from '../../../src/infrastructure/persistence/transient-errors';

const withCode = (code: string, message = 'driver error') =>
  new DriverException(Object.assign(new Error(message), { code }));

describe('isTransientDatabaseError', () => {
  test('each transient code and socket error is transient; a constraint violation and a plain Error are not', () => {
    for (const code of [
      '55P03', // lock_not_available (lock_timeout)
      '57014', // query_canceled (statement_timeout)
      '57P01', // admin_shutdown
      '08006', // connection_failure
      '53300', // too_many_connections
      '40001', // serialization_failure
      '40P01', // deadlock_detected
      '25P03', // idle_in_transaction_session_timeout
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      // A stopped Compose service leaves the network: its name no longer resolves (S12 review).
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ]) {
      expect({ code, transient: isTransientDatabaseError(withCode(code)) }).toEqual({
        code,
        transient: true,
      });
    }
    expect(isTransientDatabaseError(new LockWaitTimeoutException(withCode('55P03')))).toBe(true);
    expect(isTransientDatabaseError(new Error('timeout exceeded when trying to connect'))).toBe(
      true,
    );
    expect(isTransientDatabaseError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(
      isTransientDatabaseError(
        new Error('Connection terminated due to connection timeout', {
          cause: new Error('x'),
        }),
      ),
    ).toBe(true);
    // A refused connection wrapped by the driver keeps its code on the cause.
    expect(
      isTransientDatabaseError(new Error('wrapped', { cause: withCode('ECONNREFUSED') })),
    ).toBe(true);

    expect(isTransientDatabaseError(new CheckConstraintViolationException(withCode('23514')))).toBe(
      false,
    );
    expect(isTransientDatabaseError(withCode('42P01'))).toBe(false);
    expect(isTransientDatabaseError(new Error('stale wallet version: w'))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
    expect(isTransientDatabaseError('55P03')).toBe(false);
  });
});
