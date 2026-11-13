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
  const orm = await MikroORM.init(buildOrmConfig(env, logger, migrationsList));
  try {
    const touched = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
    return touched.map((migration) => migration.name);
  } finally {
    await orm.close(true);
  }
}
