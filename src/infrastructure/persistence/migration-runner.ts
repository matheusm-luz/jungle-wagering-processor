import type { MigrationObject } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';
import type { JsonLogger } from '../logging/json-logger';
import { migrations } from './migrations';
import { buildOrmConfig } from './mikro-orm.config';

export type MigrationDirection = 'up' | 'down';

/**
 * Applies every pending migration (`up`) or reverts the latest one (`down`) and returns the
 * names it touched. A run is one SQL transaction: PostgreSQL DDL is transactional, so a failure
 * leaves the schema exactly as it was.
 *
 * Meant to run as a one-shot step before the instances start, never at application boot.
 */
export async function runMigrations(
  env: Pick<Env, 'DATABASE_URL' | 'DATABASE_CONNECT_TIMEOUT_MS'>,
  logger: JsonLogger,
  direction: MigrationDirection,
  migrationsList: MigrationObject[] = migrations,
): Promise<string[]> {
  // Only these two fields: the env `migrate.ts` passes also holds the lock timeout, which DDL at
  // deploy time must not inherit (S9 review, m1).
  const { DATABASE_URL, DATABASE_CONNECT_TIMEOUT_MS } = env;
  const orm = await MikroORM.init(
    buildOrmConfig({ DATABASE_URL, DATABASE_CONNECT_TIMEOUT_MS }, logger, migrationsList),
  );
  try {
    const touched = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
    return touched.map((migration) => migration.name);
  } finally {
    await orm.close(true);
  }
}
