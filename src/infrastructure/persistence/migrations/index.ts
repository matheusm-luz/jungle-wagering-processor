import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261113000000_initial_schema } from './Migration20261113000000_initial_schema';
import { Migration20261113010000_system_provider } from './Migration20261113010000_system_provider';
import { Migration20261113020000_balance_limit } from './Migration20261113020000_balance_limit';
import { Migration20261113030000_correlation_id } from './Migration20261113030000_correlation_id';
import { Migration20261113040000_correlation_id_guard } from './Migration20261113040000_correlation_id_guard';

/**
 * Every migration, in execution order. The list is static, not a glob, so what runs is exactly
 * what was reviewed and no file loader is involved (ADR-13).
 */
export const migrations: MigrationObject[] = [
  {
    name: 'Migration20261113000000_initial_schema',
    class: Migration20261113000000_initial_schema,
  },
  {
    name: 'Migration20261113010000_system_provider',
    class: Migration20261113010000_system_provider,
  },
  {
    name: 'Migration20261113020000_balance_limit',
    class: Migration20261113020000_balance_limit,
  },
  {
    name: 'Migration20261113030000_correlation_id',
    class: Migration20261113030000_correlation_id,
  },
  {
    name: 'Migration20261113040000_correlation_id_guard',
    class: Migration20261113040000_correlation_id_guard,
  },
];
