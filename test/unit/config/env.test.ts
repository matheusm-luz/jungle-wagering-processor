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
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: undefined,
      WAGER_TRANSACTIONS_QUEUE_NAME: 'wager-transactions.fifo',
      READINESS_TIMEOUT_MS: 2000,
    });
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
