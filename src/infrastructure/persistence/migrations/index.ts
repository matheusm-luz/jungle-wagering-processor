import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261113000000_initial_schema } from './Migration20261113000000_initial_schema';

/**
 * Every migration, in execution order. The list is static, not a glob, so what runs is exactly
 * what was reviewed and no file loader is involved (ADR-13).
 */
export const migrations: MigrationObject[] = [
  {
    name: 'Migration20261113000000_initial_schema',
    class: Migration20261113000000_initial_schema,
  },
];
