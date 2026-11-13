import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
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
const PROVIDER = 'provider-s4';

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(amount = '100.00', currency = 'BRL'): Promise<Wallet> {
  const response = await fetch(`${app.url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: `player-${newId()}`,
      initialBalance: { amount, currency },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Wallet;
}

type Body = Record<string, unknown>;

/** A valid request body for `wallet`; `overrides` replaces single fields. */
function wager(wallet: Wallet, kind: string, amount: string, overrides: Body = {}): Body {
  return {
    providerId: PROVIDER,
    externalTransactionId: `tx-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** Sends `body` with the recommended key `{providerId}:{externalTransactionId}` unless `key` is given. */
function submit(body: Body | string, key?: string | null, headers: Record<string, string> = {}) {
  const defaultKey =
    typeof body === 'string'
      ? `key-${newId()}`
      : `${body.providerId}:${body.externalTransactionId}`;
  const idempotencyKey = key === undefined ? defaultKey : key;
  return fetch(`${app.url}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function walletRow(walletId: string) {
  const [row] = await sql`select balance, version from wallets where id = ${walletId}`;
  return row;
}

async function entriesOf(transactionId: string) {
  return sql`
    select e.direction, e.amount, e.balance_before, e.balance_after, e.sequence,
           a.kind as account_kind, a.provider_id as account_provider
      from wallet_ledger_entries e join ledger_accounts a on a.id = e.counterparty_account_id
     where e.transaction_id = ${transactionId}`;
}

async function eventsOf(transactionId: string) {
  const rows = await sql`
    select event_type, payload from outbox_messages
     where payload->'data'->>'transactionId' = ${transactionId} order by event_type`;
  return rows as { event_type: string; payload: { correlationId: string; data: Body } }[];
}

describe('POST /wagering/transactions — applied', () => {
  test('BET debits: 200 PROCESSED, one DEBIT entry against the settlement account of the provider, version + 1, two events', async () => {
    const wallet = await openWallet('100.00');
    const body = wager(wallet, 'BET', '25.00');

    const response = await submit(body, undefined, { 'X-Correlation-Id': 'bet-1' });

    expect(response.status).toBe(200);
    const result = (await response.json()) as { transactionId: string; [field: string]: unknown };
    expect(result).toEqual({
      transactionId: expect.stringMatching(UUID_V7),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });

    const [transaction] = await sql`
      select * from wager_transactions where id = ${result.transactionId}`;
    expect(transaction).toMatchObject({
      provider_id: PROVIDER,
      external_transaction_id: body.externalTransactionId,
      idempotency_key: `${PROVIDER}:${body.externalTransactionId}`,
      wallet_id: wallet.id,
      kind: 'BET',
      amount: '25.00',
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '75.00',
      observed_currency: 'BRL',
    });
    expect(await entriesOf(result.transactionId)).toEqual([
      {
        direction: 'DEBIT',
        amount: '25.00',
        balance_before: '100.00',
        balance_after: '75.00',
        sequence: 2,
        account_kind: 'PROVIDER_SETTLEMENT',
        account_provider: PROVIDER,
      },
    ]);

    const events = await eventsOf(result.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.payload.correlationId).toBe('bet-1');
    }
    expect(events[0]?.payload.data).toMatchObject({
      kind: 'BET',
      balance: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(events[1]?.payload.data).toMatchObject({
      direction: 'DEBIT',
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('WIN credits: 200 PROCESSED, one CREDIT entry against the settlement account, two events', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(wager(wallet, 'WIN', '40.50'));

    expect(response.status).toBe(200);
    const result = (await response.json()) as { transactionId: string; [field: string]: unknown };
    expect(result).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '140.50', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '140.50', version: 2 });
    expect(await entriesOf(result.transactionId)).toEqual([
      expect.objectContaining({
        direction: 'CREDIT',
        balance_before: '100.00',
        balance_after: '140.50',
        account_kind: 'PROVIDER_SETTLEMENT',
        account_provider: PROVIDER,
      }),
    ]);
    expect((await eventsOf(result.transactionId)).map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('LOSS records the outcome: 200 PROCESSED, no entry, version unchanged, only WagerTransactionProcessed', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(wager(wallet, 'LOSS', '25.00'));

    expect(response.status).toBe(200);
    const result = (await response.json()) as { transactionId: string; [field: string]: unknown };
    expect(result).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await entriesOf(result.transactionId)).toEqual([]);
    const events = await eventsOf(result.transactionId);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed']);
    expect(events[0]?.payload.data).toMatchObject({ walletVersion: 1 });
  });

  test('LOSS of 0.00 is accepted', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(wager(wallet, 'LOSS', '0.00'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'PROCESSED' });
  });

  test('a sequence of bets and wins keeps the balance and the ledger chain', async () => {
    const wallet = await openWallet('100.00');

    for (const [kind, amount] of [
      ['BET', '30.00'],
      ['WIN', '12.34'],
      ['BET', '82.34'],
      ['LOSS', '5.00'],
    ] as const) {
      expect((await submit(wager(wallet, kind, amount))).status).toBe(200);
    }

    expect(await walletRow(wallet.id)).toEqual({ balance: '0.00', version: 4 });
  });
});

/** A rejection moves nothing: same balance and version, no entry, one `WagerTransactionRejected`. */
async function expectRejected(
  response: Response,
  wallet: Wallet,
  failureCode: string,
  balance: { amount: string; currency: string },
  walletState: { balance: string; version: number },
) {
  expect(response.status).toBe(422);
  const result = (await response.json()) as { transactionId: string; [field: string]: unknown };
  expect(result).toEqual({
    transactionId: expect.stringMatching(UUID_V7),
    status: 'REJECTED',
    failureCode,
    // L-20: never the balance of a wallet the caller does not own; the row keeps it for audit.
    ...(failureCode === 'WALLET_PLAYER_MISMATCH' ? {} : { balance }),
    idempotentReplay: false,
  });
  expect(await walletRow(wallet.id)).toEqual(walletState);
  const [row] = await sql`
    select status, failure_code, observed_balance, observed_currency, processed_at
      from wager_transactions where id = ${result.transactionId}`;
  expect(row).toEqual({
    status: 'REJECTED',
    failure_code: failureCode,
    observed_balance: balance.amount,
    observed_currency: balance.currency,
    processed_at: null,
  });
  expect(await entriesOf(result.transactionId)).toEqual([]);
  const events = await eventsOf(result.transactionId);
  expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionRejected']);
  expect(events[0]?.payload.data).toMatchObject({
    failureCode,
    balance,
    walletVersion: walletState.version,
  });
  return result;
}

describe('POST /wagering/transactions — rejected', () => {
  test('a BET larger than the balance is 422 INSUFFICIENT_FUNDS with the unchanged balance', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(wager(wallet, 'BET', '100.01'));

    await expectRejected(
      response,
      wallet,
      'INSUFFICIENT_FUNDS',
      { amount: '100.00', currency: 'BRL' },
      { balance: '100.00', version: 1 },
    );
  });

  test('a BET of the whole balance is applied', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(wager(wallet, 'BET', '100.00'));

    expect(response.status).toBe(200);
    expect(await walletRow(wallet.id)).toEqual({ balance: '0.00', version: 2 });
  });

  test('a wallet of another player is 422 WALLET_PLAYER_MISMATCH without its balance, also on replay (L-20)', async () => {
    const wallet = await openWallet('100.00');
    const body = wager(wallet, 'BET', '10.00', { playerId: 'someone-else' });

    const original = await expectRejected(
      await submit(body),
      wallet,
      'WALLET_PLAYER_MISMATCH',
      { amount: '100.00', currency: 'BRL' },
      { balance: '100.00', version: 1 },
    );

    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  });

  test('another currency is 422 CURRENCY_MISMATCH with the balance in the wallet currency', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(
      wager(wallet, 'WIN', '10.00', { money: { amount: '10.00', currency: 'USD' } }),
    );

    await expectRejected(
      response,
      wallet,
      'CURRENCY_MISMATCH',
      { amount: '100.00', currency: 'BRL' },
      { balance: '100.00', version: 1 },
    );
  });

  test('a WIN beyond the storable balance is 422 BALANCE_LIMIT_EXCEEDED (Q1)', async () => {
    const max = '99999999999999999.99';
    const wallet = await openWallet(max);

    const response = await submit(wager(wallet, 'WIN', '0.01'));

    await expectRejected(
      response,
      wallet,
      'BALANCE_LIMIT_EXCEEDED',
      { amount: max, currency: 'BRL' },
      { balance: max, version: 1 },
    );
  });
});

async function rowCounts(walletId: string) {
  const [row] = await sql`
    select (select count(*)::int from wager_transactions where wallet_id = ${walletId}) as transactions,
           (select count(*)::int from wallet_ledger_entries where wallet_id = ${walletId}) as entries,
           (select count(*)::int from outbox_messages where aggregate_id = ${walletId}) as events`;
  return row;
}

describe('POST /wagering/transactions — idempotency', () => {
  test('the same request replays the original result with idempotentReplay true, even after the balance moved', async () => {
    const wallet = await openWallet('100.00');
    const first = wager(wallet, 'BET', '25.00');
    const original = (await (await submit(first)).json()) as Body;
    expect((await submit(wager(wallet, 'BET', '10.00'))).status).toBe(200);
    const before = await rowCounts(wallet.id);

    const replay = await submit(first);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(original.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await walletRow(wallet.id)).toEqual({ balance: '65.00', version: 3 });
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  test('a replay is answered the same by another instance', async () => {
    const wallet = await openWallet('100.00');
    const body = wager(wallet, 'WIN', '5.00');
    const original = (await (await submit(body)).json()) as Body;
    const other = await startApp();

    try {
      const replay = await fetch(`${other.url}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
        },
        body: JSON.stringify(body),
      });

      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    } finally {
      await other.close();
    }
    expect(await walletRow(wallet.id)).toEqual({ balance: '105.00', version: 2 });
  });

  test('a replay of a rejection is 422 again and writes nothing', async () => {
    const wallet = await openWallet('10.00');
    const body = wager(wallet, 'BET', '50.00');
    const original = (await (await submit(body)).json()) as Body;
    // The balance grows enough for the bet; the replay still answers the original rejection.
    expect((await submit(wager(wallet, 'WIN', '100.00'))).status).toBe(200);
    const before = await rowCounts(wallet.id);

    const replay = await submit(body);

    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(original).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  test('the same key with another payload is 409 IDEMPOTENCY_KEY_CONFLICT and writes nothing', async () => {
    const wallet = await openWallet('100.00');
    const body = wager(wallet, 'BET', '25.00');
    const key = `${body.providerId}:${body.externalTransactionId}`;
    expect((await submit(body)).status).toBe(200);
    const before = await rowCounts(wallet.id);

    for (const changed of [
      { ...body, money: { amount: '25.01', currency: 'BRL' } },
      { ...body, roundId: 'round-2' },
      { ...body, externalTransactionId: `tx-${newId()}` },
    ]) {
      const response = await submit(changed, key);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: expect.any(String),
      });
    }
    expect(await rowCounts(wallet.id)).toEqual(before);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
  });

  test('the same provider and external id under another key is 409 EXTERNAL_TRANSACTION_CONFLICT', async () => {
    const wallet = await openWallet('100.00');
    const body = wager(wallet, 'BET', '25.00');
    expect((await submit(body)).status).toBe(200);
    const before = await rowCounts(wallet.id);

    const response = await submit(body, `another-key-${newId()}`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'EXTERNAL_TRANSACTION_CONFLICT',
      message: expect.any(String),
    });
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  // Whichever path answers the loser — the lookup, or the unique index when both pass the lookup
  // before either commits — the outcome is the same. The index path alone is proven
  // deterministically by unit-of-work.test.ts "a duplicate idempotency key … becomes a 409 error".
  test('the same key sent concurrently to two wallets: one 200, one 409 IDEMPOTENCY_KEY_CONFLICT, one debit', async () => {
    const wallets = await Promise.all([openWallet('100.00'), openWallet('100.00')]);
    const externalTransactionId = `tx-${newId()}`;
    const key = `${PROVIDER}:${externalTransactionId}`;

    const responses = await Promise.all(
      wallets.map((wallet) =>
        submit(wager(wallet, 'BET', '10.00', { externalTransactionId }), key),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect([...statuses].sort()).toEqual([200, 409]);
    const loser = statuses.indexOf(409);
    expect(await responses[loser]?.json()).toEqual({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: expect.any(String),
    });
    const states = await Promise.all(wallets.map((wallet) => walletRow(wallet.id)));
    expect(states[1 - loser]).toEqual({ balance: '90.00', version: 2 });
    expect(states[loser]).toEqual({ balance: '100.00', version: 1 });
    expect(
      await sql`select id from wager_transactions where idempotency_key = ${key}`,
    ).toHaveLength(1);
  });
});

describe('POST /wagering/transactions — not processed', () => {
  test('no Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED and writes nothing', async () => {
    const wallet = await openWallet('100.00');

    for (const key of [null, '']) {
      const response = await submit(wager(wallet, 'BET', '10.00'), key);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: expect.any(String),
      });
    }
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 1, entries: 1, events: 2 });
  });

  test('an invalid body or key is 400 VALIDATION_ERROR and writes nothing', async () => {
    const wallet = await openWallet('100.00');
    const valid = wager(wallet, 'BET', '10.00');
    const { money: _money, ...withoutMoney } = valid;
    const invalid: [unknown, string?][] = [
      [{ ...valid, kind: 'OPENING' }],
      [{ ...valid, kind: 'REFUND', referenceExternalTransactionId: 'tx-1' }],
      [{ ...valid, kind: 'ROLLBACK', referenceExternalTransactionId: 'tx-1' }],
      [{ ...valid, kind: 'WIN', referenceExternalTransactionId: 'tx-1' }],
      [{ ...valid, kind: 'bet' }],
      [{ ...valid, providerId: 'SYSTEM' }],
      [{ ...valid, unknown: 'field' }],
      [{ ...valid, money: { amount: '10', currency: 'BRL' } }],
      [{ ...valid, money: { amount: '-1.00', currency: 'BRL' } }],
      [{ ...valid, money: { amount: 10, currency: 'BRL' } }],
      [{ ...valid, money: { amount: '10.00', currency: 'brl' } }],
      [{ ...valid, money: { amount: '0.00', currency: 'BRL' } }],
      [{ ...valid, kind: 'WIN', money: { amount: '0.00', currency: 'BRL' } }],
      [{ ...valid, walletId: 'not-a-uuid' }],
      [{ ...valid, playerId: '' }],
      [{ ...valid, roundId: 'x'.repeat(129) }],
      [{ ...valid, gameId: `game${String.fromCharCode(0)}` }],
      [{ ...valid, externalTransactionId: 42 }],
      [withoutMoney],
      [[]],
      ['{"providerId": '],
      [valid, 'k'.repeat(257)],
      [valid, 'key with space'],
      // Outside visible ASCII a header and a JSON field (SQS) may not decode to the same key.
      [valid, 'chave-é'],
    ];

    for (const [body, key] of invalid) {
      const response = await submit(body as Body, key);

      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(await response.json()).toEqual({
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      });
    }
    expect(await rowCounts(wallet.id)).toEqual({ transactions: 1, entries: 1, events: 2 });
  });

  test('an unknown wallet is 404 WALLET_NOT_FOUND and writes nothing', async () => {
    const walletId = newId();

    const response = await submit(wager({ id: walletId, playerId: 'nobody' }, 'BET', '10.00'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 'WALLET_NOT_FOUND',
      message: expect.any(String),
    });
    expect(await sql`select id from wager_transactions where wallet_id = ${walletId}`).toEqual([]);
  });
});
