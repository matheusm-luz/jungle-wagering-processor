import type { MigrationObject } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';
import type { JsonLogger } from '../logging/json-logger';
import { migrations } from './migrations';

export function buildOrmConfig(
  env: Pick<Env, 'DATABASE_URL' | 'DATABASE_CONNECT_TIMEOUT_MS'>,
  logger: JsonLogger,
  migrationsList: MigrationObject[] = migrations,
) {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    // Passed to the `pg` pool. Bounds a connection attempt to a server that stopped answering,
    // which would otherwise hang its caller and, at shutdown, `orm.close()`.
    driverOptions: { connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS },
    // Explicit list, no globs. Empty until the persistence records of S2 exist.
    entities: [],
    discovery: { warnWhenNoEntities: false },
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
