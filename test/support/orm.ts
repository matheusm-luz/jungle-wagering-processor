import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { silentLogger, testEnv } from './database';

/** The application's own ORM configuration, on the suite database. Migrate before using it. */
export function startOrm(): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig(testEnv, silentLogger));
}
