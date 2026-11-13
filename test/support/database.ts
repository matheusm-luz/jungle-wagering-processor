import { expect } from 'bun:test';
import { SQL } from 'bun';
import { loadEnv } from '../../src/config/env';
import { JsonLogger } from '../../src/infrastructure/logging/json-logger';
import { runMigrations } from '../../src/infrastructure/persistence/migration-runner';

export const testEnv = loadEnv(process.env);
export const silentLogger = new JsonLogger({ level: 'silent', write: () => {} });

/** Applies every pending migration and returns a client on the suite database. */
export async function migratedDatabase(): Promise<SQL> {
  await runMigrations(testEnv, silentLogger, 'up');
  return new SQL(testEnv.DATABASE_URL);
}

/**
 * Asserts that `query` is refused by PostgreSQL with `sqlState` and, when given, by the named
 * constraint or with a message matching `message`. Bun reports the SQLSTATE in `errno`.
 */
export async function expectRefused(
  query: PromiseLike<unknown>,
  expected: { sqlState: string; constraint?: string; message?: RegExp },
): Promise<void> {
  let error: unknown;
  try {
    await query;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  const { errno, constraint, message } = error as {
    errno?: string;
    constraint?: string;
    message: string;
  };
  expect({ sqlState: errno, constraint, message }).toMatchObject({
    sqlState: expected.sqlState,
    ...(expected.constraint === undefined ? {} : { constraint: expected.constraint }),
    ...(expected.message === undefined ? {} : { message: expect.stringMatching(expected.message) }),
  });
}

const ROLLBACK = Symbol('rollback');

/**
 * Runs `work` in a transaction that is always rolled back, for a test that must write a row the
 * ledger invariant would reject if it stayed (a balance with no entries behind it).
 */
export async function inRolledBackTransaction(
  sql: SQL,
  work: (tx: SQL) => Promise<void>,
): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await work(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

export const SqlState = {
  checkViolation: '23514',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  notNullViolation: '23502',
  raiseException: 'P0001',
} as const;
