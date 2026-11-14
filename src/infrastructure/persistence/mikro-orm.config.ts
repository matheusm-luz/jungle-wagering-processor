import type { MigrationObject } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';
import type { JsonLogger } from '../logging/json-logger';
import { migrations } from './migrations';
import { records } from './records';

export function buildOrmConfig(
  // No lock or idle timeout for the migrator: DDL at deploy time may wait for its locks.
  env: Pick<Env, 'DATABASE_URL' | 'DATABASE_CONNECT_TIMEOUT_MS'> &
    Partial<Pick<Env, 'DATABASE_LOCK_TIMEOUT_MS' | 'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS'>>,
  logger: JsonLogger,
  migrationsList: MigrationObject[] = migrations,
) {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    // Passed to the `pg` pool. Bounds a connection attempt to a server that stopped answering,
    // which would otherwise hang its caller and, at shutdown, `orm.close()`.
    // `lock_timeout` and `idle_in_transaction_session_timeout` go in the startup packet of every
    // connection: no extra round trip (ADR-01; S10 review, m1).
    driverOptions: {
      connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,
      lock_timeout: env.DATABASE_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    // Explicit list, no globs.
    entities: records,
    // The application never creates its database; that is provisioning, not runtime.
    ensureDatabase: false,
    extensions: [Migrator],
    migrations: { migrationsList, snapshot: false, transactional: true, allOrNothing: true },
    // The ORM's own lines (migrator progress) go through the JSON logger. `debug` stays off:
    // query logging prints SQL parameters, which are financial data.
    logger: (message) => logger.info(message, { context: 'MikroORM' }),
    colors: false,
    debug: false,
  });
}
