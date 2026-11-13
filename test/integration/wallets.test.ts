import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { payloadHash } from '../../src/application/payload-hash';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { startApp, type TestApp } from '../support/app';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { newId } from '../support/schema-fixtures';

let app: TestApp;
let sql: SQL;

beforeAll(async () => {
  sql = await migratedDatabase();
  app = await startApp();
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await app.close();
  await sql.close();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function openWallet(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${app.url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const newPlayer = () => `player-${newId()}`;
const balance = (amount: string, currency = 'BRL') => ({ amount, currency });

async function walletsOf(playerId: string) {
  return sql`select * from wallets where player_id = ${playerId}`;
}

async function transactionsOf(playerId: string) {
  return sql`select * from wager_transactions where player_id = ${playerId}`;
}

describe('POST /wallets', () => {
  test('a positive balance commits the wallet at version 1, a PROCESSED OPENING with its observed balance, one CREDIT entry at sequence 1 against FUNDING and two outbox events', async () => {
    const playerId = newPlayer();

    const response = await openWallet(
      { playerId, initialBalance: balance('1000.00') },
      { 'X-Correlation-Id': 'open-wallet-1' },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; [field: string]: unknown };
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V7),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = body.id;

    const [wallet] = await walletsOf(playerId);
    expect(wallet).toMatchObject({ id: walletId, balance: '1000.00', currency: 'BRL', version: 1 });

    const [opening, ...others] = await transactionsOf(playerId);
    expect(others).toEqual([]);
    expect(opening).toMatchObject({
      provider_id: 'SYSTEM',
      external_transaction_id: `opening:${walletId}`,
      idempotency_key: `opening:${walletId}`,
      wallet_id: walletId,
      round_id: 'OPENING',
      game_id: 'OPENING',
      kind: 'OPENING',
      amount: '1000.00',
      currency: 'BRL',
      reference_external_transaction_id: null,
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '1000.00',
      observed_currency: 'BRL',
      payload_hash: payloadHash({
        providerId: 'SYSTEM',
        externalTransactionId: `opening:${walletId}`,
        playerId,
        walletId,
        roundId: 'OPENING',
        gameId: 'OPENING',
        kind: WagerTransactionKind.Opening,
        money: Money.from(balance('1000.00')),
      }),
    });
    expect(opening?.processed_at).toBeInstanceOf(Date);

    const entries = await sql`
      select e.direction, e.amount, e.balance_before, e.balance_after, e.sequence,
             e.transaction_id, a.kind as account_kind, a.currency as account_currency
        from wallet_ledger_entries e join ledger_accounts a on a.id = e.counterparty_account_id
       where e.wallet_id = ${walletId}`;
    expect(entries).toEqual([
      {
        direction: 'CREDIT',
        amount: '1000.00',
        balance_before: '0.00',
        balance_after: '1000.00',
        sequence: 1,
        transaction_id: opening?.id,
        account_kind: 'FUNDING',
        account_currency: 'BRL',
      },
    ]);

    const events = await sql`
      select event_type, payload from outbox_messages
       where aggregate_id = ${walletId} order by event_type`;
    expect(events.map((row: { event_type: string }) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const { payload } of events) {
      expect(payload).toMatchObject({ aggregateId: walletId, correlationId: 'open-wallet-1' });
    }
    expect(events[1].payload.data).toEqual({
      walletId,
      transactionId: opening?.id,
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test('a zero balance commits the wallet only: no transaction, no entry, no event', async () => {
    const playerId = newPlayer();

    const response = await openWallet({ playerId, initialBalance: balance('0.00') });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; [field: string]: unknown };
    expect(body).toMatchObject({
      playerId,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(await walletsOf(playerId)).toHaveLength(1);
    expect(await transactionsOf(playerId)).toEqual([]);
    expect(await sql`select id from wallet_ledger_entries where wallet_id = ${body.id}`).toEqual(
      [],
    );
    expect(await sql`select id from outbox_messages where aggregate_id = ${body.id}`).toEqual([]);
  });

  test('a duplicate player and currency is 409 WALLET_ALREADY_EXISTS and adds no row', async () => {
    const playerId = newPlayer();
    const first = await openWallet({ playerId, initialBalance: balance('10.00') });
    expect(first.status).toBe(201);

    const second = await openWallet({ playerId, initialBalance: balance('20.00') });

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      code: 'WALLET_ALREADY_EXISTS',
      message: expect.any(String),
    });
    expect(await walletsOf(playerId)).toHaveLength(1);
    expect(await transactionsOf(playerId)).toHaveLength(1);
  });

  test('the same player may open a wallet in another currency', async () => {
    const playerId = newPlayer();

    const brl = await openWallet({ playerId, initialBalance: balance('10.00') });
    const usd = await openWallet({ playerId, initialBalance: balance('10.00', 'USD') });

    expect([brl.status, usd.status]).toEqual([201, 201]);
    expect(await walletsOf(playerId)).toHaveLength(2);
  });

  test('ten concurrent requests for one player and currency: one 201, nine 409, one wallet', async () => {
    const playerId = newPlayer();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => openWallet({ playerId, initialBalance: balance('5.00') })),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(9).fill(409)]);
    expect(await walletsOf(playerId)).toHaveLength(1);
    expect(await transactionsOf(playerId)).toHaveLength(1);
  });

  test('an invalid body is 400 VALIDATION_ERROR and writes nothing', async () => {
    const playerId = newPlayer();
    const invalid: unknown[] = [
      { playerId, initialBalance: balance('25') },
      { playerId, initialBalance: balance('25.5') },
      { playerId, initialBalance: balance('-1.00') },
      { playerId, initialBalance: balance('+1.00') },
      { playerId, initialBalance: balance('1.00', 'brl') },
      { playerId, initialBalance: { amount: 10, currency: 'BRL' } },
      { playerId, initialBalance: { ...balance('1.00'), extra: true } },
      { playerId, initialBalance: balance('1.00'), unknown: 'field' },
      { playerId: '', initialBalance: balance('1.00') },
      { playerId: 'x'.repeat(129), initialBalance: balance('1.00') },
      // PostgreSQL cannot store U+0000 in text: it must be a 400, not a driver error and a 500.
      { playerId: `${playerId}\u0000`, initialBalance: balance('1.00') },
      { initialBalance: balance('1.00') },
      { playerId },
      [],
      '{"playerId": ',
    ];

    for (const body of invalid) {
      const response = await openWallet(body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(await response.json()).toEqual({
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      });
    }
    expect(await walletsOf(playerId)).toEqual([]);
  });
});

describe('GET /wallets/:walletId', () => {
  test('returns the wallet as POST answered it', async () => {
    const created = await openWallet({ playerId: newPlayer(), initialBalance: balance('42.10') });
    const body = await created.json();

    const response = await fetch(`${app.url}/wallets/${(body as { id: string }).id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  test('an unknown id is 404 WALLET_NOT_FOUND', async () => {
    const response = await fetch(`${app.url}/wallets/${newId()}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 'WALLET_NOT_FOUND',
      message: expect.any(String),
    });
  });

  test('an id that is not a UUID is 400 VALIDATION_ERROR, not a database error', async () => {
    // `%FF` is not valid percent-encoding: Express fails to decode it before the route runs.
    for (const id of ['not-a-uuid', '123', `${newId()}x`, '%FF']) {
      const response = await fetch(`${app.url}/wallets/${id}`);

      expect({ id, status: response.status }).toEqual({ id, status: 400 });
      expect(await response.json()).toEqual({
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      });
    }
  });
});
