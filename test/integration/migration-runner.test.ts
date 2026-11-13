import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MigrationObject } from '@mikro-orm/core';
import { Migration } from '@mikro-orm/migrations';
import { SQL } from 'bun';
import { loadEnv } from '../../src/config/env';
import { JsonLogger } from '../../src/infrastructure/logging/json-logger';
import { runMigrations } from '../../src/infrastructure/persistence/migration-runner';

class CreateProbe extends Migration {
  override up(): void {
    this.addSql('create table harness_probe (id integer primary key)');
  }

  override down(): void {
    this.addSql('drop table harness_probe');
  }
}

class BrokenHalfway extends Migration {
  override up(): void {
    this.addSql('create table harness_half_done (id integer primary key)');
    this.addSql('alter table harness_no_such_table add column x integer');
  }

  override down(): void {}
}

const PROBE: MigrationObject = {
  name: 'Migration00000000000001_harness_probe',
  class: CreateProbe,
};
const BROKEN: MigrationObject = { name: 'Migration00000000000002_broken', class: BrokenHalfway };

const env = loadEnv(process.env);
const logLines: string[] = [];
const logger = new JsonLogger({ level: 'info', write: (line) => logLines.push(line) });
const sql = new SQL(env.DATABASE_URL);

async function tableExists(name: string): Promise<boolean> {
  const [row] = await sql`select to_regclass(${`public.${name}`}) is not null as found`;
  return row.found;
}

async function recordedMigrations(): Promise<string[]> {
  if (!(await tableExists('mikro_orm_migrations'))) {
    return [];
  }
  const rows =
    await sql`select name from mikro_orm_migrations where name like '%harness%' or name like '%broken%' order by name`;
  return rows.map((row: { name: string }) => row.name);
}

beforeEach(async () => {
  await sql`drop table if exists harness_probe, harness_half_done`;
  if (await tableExists('mikro_orm_migrations')) {
    await sql`delete from mikro_orm_migrations where name like '%harness%' or name like '%broken%'`;
  }
});

afterAll(async () => {
  await sql.close();
});

describe('migration runner', () => {
  test('up applies a migration, a second up is a no-op, down reverts it', async () => {
    expect(await runMigrations(env, logger, 'up', [PROBE])).toEqual([PROBE.name]);
    expect(await tableExists('harness_probe')).toBe(true);
    expect(logLines.map((line) => JSON.parse(line).message)).toContain(
      `[migrator] Applied '${PROBE.name}'`,
    );
    expect(await recordedMigrations()).toEqual([PROBE.name]);

    expect(await runMigrations(env, logger, 'up', [PROBE])).toEqual([]);
    expect(await recordedMigrations()).toEqual([PROBE.name]);

    expect(await runMigrations(env, logger, 'down', [PROBE])).toEqual([PROBE.name]);
    expect(await tableExists('harness_probe')).toBe(false);
    expect(await recordedMigrations()).toEqual([]);
  });

  test('a failing run leaves no migration applied, not even the ones before the failure', async () => {
    await expect(runMigrations(env, logger, 'up', [PROBE, BROKEN])).rejects.toThrow(
      /harness_no_such_table/,
    );

    expect(await tableExists('harness_probe')).toBe(false);
    expect(await tableExists('harness_half_done')).toBe(false);
    expect(await recordedMigrations()).toEqual([]);
  });

  test('the application list applies cleanly and is idempotent', async () => {
    await runMigrations(env, logger, 'up');

    expect(await runMigrations(env, logger, 'up')).toEqual([]);
  });
});
