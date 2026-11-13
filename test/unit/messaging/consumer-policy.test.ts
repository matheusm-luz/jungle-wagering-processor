import { describe, expect, test } from 'bun:test';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { RequestValidationError } from '../../../src/infrastructure/http/request-validation.error';
import { classify, visibilityBackoff } from '../../../src/infrastructure/messaging/consumer-policy';

describe('SQS consumer policy (ADR-05)', () => {
  test('backoff doubles per receive and is capped', () => {
    const delays = [1, 2, 3, 4, 5, 6].map((receives) => visibilityBackoff(receives, 5, 120));
    expect(delays).toEqual([5, 10, 20, 40, 80, 120]);
    expect(visibilityBackoff(3, 0, 120)).toBe(0);
  });

  test('validation errors, an inbox conflict and the 409 conflicts are permanent; anything else is transient', () => {
    for (const error of [
      new RequestValidationError('money: invalid'),
      new InvalidWagerTransactionError('zero amount'),
      new InboxMessageConflictError(),
      new IdempotencyKeyConflictError(),
      new ExternalTransactionConflictError(),
    ]) {
      expect({ name: error.name, kind: classify(error) }).toEqual({
        name: error.name,
        kind: 'permanent',
      });
    }
    // Answered by the use case without throwing on SQS (L-08); a throw here is not expected.
    expect(classify(new WalletNotFoundError())).toBe('transient');
    expect(classify(Object.assign(new Error('lock timeout'), { code: '55P03' }))).toBe('transient');
    expect(classify('not an error')).toBe('transient');
  });
});
