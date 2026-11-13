import type { MigrationObject } from '@mikro-orm/core';

/**
 * Every migration, in execution order. The list is static, not a glob, so what runs is exactly
 * what was reviewed and no file loader is involved (ADR-13). The schema arrives in slice S2.
 */
export const migrations: MigrationObject[] = [];
