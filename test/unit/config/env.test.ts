import { describe, expect, test } from 'bun:test';
import { EnvValidationError, loadEnv } from '../../../src/config/env';

const DATABASE_URL = 'postgresql://wagering:s3cret-pw@localhost:5432/wagering';

describe('loadEnv', () => {
  test('applies defaults', () => {
    const env = loadEnv({ DATABASE_URL });

    expect(env).toEqual({
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL,
      DATABASE_CONNECT_TIMEOUT_MS: 5000,
      DATABASE_LOCK_TIMEOUT_MS: 5000,
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: undefined,
      WAGER_TRANSACTIONS_QUEUE_NAME: 'wager-transactions.fifo',
      WAGER_TRANSACTIONS_DLQ_NAME: 'wager-transactions-dlq.fifo',
      SQS_CONSUMER_CONCURRENCY: 5,
      SQS_WAIT_TIME_S: 10,
      SQS_VISIBILITY_TIMEOUT_S: 30,
      SQS_RETRY_BASE_DELAY_S: 5,
      SQS_RETRY_MAX_DELAY_S: 120,
      SQS_SHUTDOWN_GRACE_MS: 10_000,
      SQS_CONSUMER_FAILPOINT: undefined,
      READINESS_TIMEOUT_MS: 2000,
      PENDING_REFERENCE_BASE_DELAY_MS: 1000,
      PENDING_REFERENCE_MAX_DELAY_MS: 60_000,
      PENDING_REFERENCE_MAX_ATTEMPTS: 10,
      PENDING_REFERENCE_POLL_INTERVAL_MS: 500,
      PENDING_REFERENCE_BATCH_SIZE: 10,
    });
  });

  test('reads the pending-reference worker settings (ADR-05)', () => {
    const env = loadEnv({
      DATABASE_URL,
      PENDING_REFERENCE_BASE_DELAY_MS: '5',
      PENDING_REFERENCE_MAX_DELAY_MS: '40',
      PENDING_REFERENCE_MAX_ATTEMPTS: '3',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '20',
      PENDING_REFERENCE_BATCH_SIZE: '2',
    });

    expect(env).toMatchObject({
      PENDING_REFERENCE_BASE_DELAY_MS: 5,
      PENDING_REFERENCE_MAX_DELAY_MS: 40,
      PENDING_REFERENCE_MAX_ATTEMPTS: 3,
      PENDING_REFERENCE_POLL_INTERVAL_MS: 20,
      PENDING_REFERENCE_BATCH_SIZE: 2,
    });
    expect(() => loadEnv({ DATABASE_URL, PENDING_REFERENCE_MAX_ATTEMPTS: '0' })).toThrow(
      EnvValidationError,
    );
  });

  test('reads every variable from the source', () => {
    const env = loadEnv({
      PORT: '8080',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      AWS_REGION: 'sa-east-1',
      AWS_ENDPOINT_URL: 'http://localstack:4566',
      WAGER_TRANSACTIONS_QUEUE_NAME: 'other.fifo',
      READINESS_TIMEOUT_MS: '250',
    });

    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('silent');
    expect(env.AWS_REGION).toBe('sa-east-1');
    expect(env.AWS_ENDPOINT_URL).toBe('http://localstack:4566');
    expect(env.WAGER_TRANSACTIONS_QUEUE_NAME).toBe('other.fifo');
    expect(env.READINESS_TIMEOUT_MS).toBe(250);
  });

  test('rejects a missing DATABASE_URL and names the variable', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  test('rejects an invalid PORT', () => {
    for (const PORT of ['0', '70000', '80.5', 'http']) {
      expect(() => loadEnv({ DATABASE_URL, PORT })).toThrow(/PORT/);
    }
  });

  test('reports every invalid variable at once', () => {
    const load = () => loadEnv({ PORT: 'x', LOG_LEVEL: 'loud' });

    expect(load).toThrow(/DATABASE_URL/);
    expect(load).toThrow(/LOG_LEVEL/);
    expect(load).toThrow(/PORT/);
  });

  test('never echoes a value in the error', () => {
    const secret = 'mysql://wagering:s3cret-pw@localhost/wagering';

    try {
      loadEnv({ DATABASE_URL: secret, AWS_ENDPOINT_URL: 'not a url s3cret-endpoint' });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('AWS_ENDPOINT_URL');
      expect(message).not.toContain('s3cret');
    }
  });
});
