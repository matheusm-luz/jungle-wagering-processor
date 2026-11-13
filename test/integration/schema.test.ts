import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { runMigrations } from '../../src/infrastructure/persistence/migration-runner';
import { migrations } from '../../src/infrastructure/persistence/migrations';
import { silentLogger, testEnv } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';

const TABLES = [
  'inbox_messages',
  'ledger_accounts',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

/**
 * The down/up cycle runs on a throwaway database of its own. On the shared suite database it
 * would drop the rows every other file wrote, and their final ledger checks would pass on an
 * empty schema depending on the order the files run in.
 */
const DATABASE = 'wagering_schema_lifecycle';
const url = new URL(testEnv.DATABASE_URL);
url.pathname = `/${DATABASE}`;
const env = { ...testEnv, DATABASE_URL: url.toString() };

const admin = new SQL(testEnv.DATABASE_URL);
let sql: SQL;

beforeAll(async () => {
  await admin.unsafe(`drop database if exists ${DATABASE} with (force)`);
  await admin.unsafe(`create database ${DATABASE}`);
  await runMigrations(env, silentLogger, 'up');
  sql = new SQL(env.DATABASE_URL);
});

afterAll(async () => {
  await sql.close();
  await admin.unsafe(`drop database if exists ${DATABASE} with (force)`);
  await admin.close();
});

async function publicTables(): Promise<string[]> {
  const rows = await sql`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
     order by table_name`;
  return rows.map((row: { table_name: string }) => row.table_name);
}

async function publicFunctions(): Promise<string[]> {
  const rows = await sql`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' order by p.proname`;
  return rows.map((row: { proname: string }) => row.proname);
}

describe('schema migrations', () => {
  test('up creates every table of ARCHITECTURE §3', async () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(await publicTables()).toEqual(TABLES);
    await expectLedgerInvariant(sql);
  });

  test('down reverts every migration and leaves an empty public schema; up applies again', async () => {
    const reverted: string[] = [];
    for (;;) {
      const names = await runMigrations(env, silentLogger, 'down');
      if (names.length === 0) break;
      reverted.push(...names);
    }

    expect(reverted).toEqual(migrations.map((migration) => migration.name).reverse());
    expect(await publicTables()).toEqual([]);
    expect(await publicFunctions()).toEqual([]);

    expect(await runMigrations(env, silentLogger, 'up')).toEqual(
      migrations.map((migration) => migration.name),
    );
    expect(await publicTables()).toEqual(TABLES);
    await expectLedgerInvariant(sql);
  });
});
