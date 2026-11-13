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
      // L-18: REFUND and ROLLBACK require a reference, BET refuses one, none references itself.
      [{ ...valid, kind: 'REFUND' }],
      [{ ...valid, kind: 'ROLLBACK' }],
      [{ ...valid, referenceExternalTransactionId: 'tx-1' }],
      [{ ...valid, kind: 'REFUND', referenceExternalTransactionId: valid.externalTransactionId }],
      [{ ...valid, kind: 'REFUND', referenceExternalTransactionId: '' }],
      [{ ...valid, kind: 'REFUND', referenceExternalTransactionId: 'x'.repeat(129) }],
      [{ ...valid, kind: 'WIN', referenceExternalTransactionId: 42 }],
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

// ---- S6: reversals and references (statement §7)

type Result = { transactionId: string; status: string; [field: string]: unknown };

/** Submits `body`, expects 200 PROCESSED and returns the body sent and the answer. */
async function applied(body: Body): Promise<{ body: Body; result: Result }> {
  const response = await submit(body);
  const result = (await response.json()) as Result;
  expect({ status: response.status, result }).toMatchObject({
    status: 200,
    result: { status: 'PROCESSED' },
  });
  return { body, result };
}

/** A request of `kind` that references `reference`, a body sent before. */
function referencing(
  wallet: Wallet,
  kind: string,
  amount: string,
  reference: Body,
  overrides: Body = {},
): Body {
  return wager(wallet, kind, amount, {
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

async function referenceOf(transactionId: string) {
  const [row] = await sql`
    select reference_external_transaction_id, reference_transaction_id
      from wager_transactions where id = ${transactionId}`;
  return row;
}

describe('POST /wagering/transactions — reversals applied', () => {
  test('REFUND of a BET credits it back against the settlement account and resolves the reference', async () => {
    const wallet = await openWallet('100.00');
    const bet = await applied(wager(wallet, 'BET', '30.00'));

    const refund = await applied(referencing(wallet, 'REFUND', '30.00', bet.body));

    expect(refund.result).toEqual({
      transactionId: expect.stringMatching(UUID_V7),
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    expect(await entriesOf(refund.result.transactionId)).toEqual([
      {
        direction: 'CREDIT',
        amount: '30.00',
        balance_before: '70.00',
        balance_after: '100.00',
        sequence: 3,
        account_kind: 'PROVIDER_SETTLEMENT',
        account_provider: PROVIDER,
      },
    ]);
    expect(await referenceOf(refund.result.transactionId)).toEqual({
      reference_external_transaction_id: bet.body.externalTransactionId,
      reference_transaction_id: bet.result.transactionId,
    });
    expect((await eventsOf(refund.result.transactionId)).map((e) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('ROLLBACK inverts its reference: a BET is credited, a WIN and a REFUND are debited', async () => {
    const wallet = await openWallet('100.00');
    const movement = async (transactionId: string) =>
      (await entriesOf(transactionId)).map((e: Body) => `${e.direction} ${e.balance_after}`);

    const bet = await applied(wager(wallet, 'BET', '30.00'));
    const ofBet = await applied(referencing(wallet, 'ROLLBACK', '30.00', bet.body));
    const win = await applied(wager(wallet, 'WIN', '50.00'));
    const ofWin = await applied(referencing(wallet, 'ROLLBACK', '50.00', win.body));
    const bet2 = await applied(wager(wallet, 'BET', '20.00'));
    const refund = await applied(referencing(wallet, 'REFUND', '20.00', bet2.body));
    const ofRefund = await applied(referencing(wallet, 'ROLLBACK', '20.00', refund.body));

    expect(await movement(ofBet.result.transactionId)).toEqual(['CREDIT 100.00']);
    expect(await movement(ofWin.result.transactionId)).toEqual(['DEBIT 100.00']);
    expect(await movement(ofRefund.result.transactionId)).toEqual(['DEBIT 80.00']);
    expect(await walletRow(wallet.id)).toEqual({ balance: '80.00', version: 8 });
  });

  test('a WIN and a LOSS referencing their BET are applied with the reference resolved (L-09)', async () => {
    const wallet = await openWallet('100.00');
    const bet = await applied(wager(wallet, 'BET', '30.00'));

    const win = await applied(referencing(wallet, 'WIN', '75.00', bet.body));
    const loss = await applied(referencing(wallet, 'LOSS', '0.00', bet.body));

    for (const { result } of [win, loss]) {
      expect((await referenceOf(result.transactionId)).reference_transaction_id).toBe(
        bet.result.transactionId,
      );
    }
    expect(await entriesOf(loss.result.transactionId)).toEqual([]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '145.00', version: 3 });
  });

  test('a reversal replays its original result; the same key with another reference is 409', async () => {
    const wallet = await openWallet('100.00');
    const bet = await applied(wager(wallet, 'BET', '30.00'));
    const other = await applied(wager(wallet, 'BET', '30.00'));
    const refund = await applied(referencing(wallet, 'REFUND', '30.00', bet.body));
    const before = await rowCounts(wallet.id);

    const replay = await submit(refund.body);
    const conflict = await submit(
      { ...refund.body, referenceExternalTransactionId: other.body.externalTransactionId },
      `${refund.body.providerId}:${refund.body.externalTransactionId}`,
    );

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...refund.result, idempotentReplay: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await rowCounts(wallet.id)).toEqual(before);
  });
});

describe('POST /wagering/transactions — reversals rejected', () => {
  test('refund then rollback of the same BET: the rollback is 422 REFERENCE_ALREADY_REVERSED (L-01)', async () => {
    const wallet = await openWallet('100.00');
    const bet = await applied(wager(wallet, 'BET', '30.00'));
    await applied(referencing(wallet, 'REFUND', '30.00', bet.body));

    const rejected = await expectRejected(
      await submit(referencing(wallet, 'ROLLBACK', '30.00', bet.body)),
      wallet,
      'REFERENCE_ALREADY_REVERSED',
      { amount: '100.00', currency: 'BRL' },
      { balance: '100.00', version: 3 },
    );
    // A rejection keeps only the declared id: the resolved one may belong to another wallet.
    expect((await referenceOf(rejected.transactionId)).reference_transaction_id).toBe(null);
  });

  test('a second ROLLBACK of a WIN or of a REFUND is 422 REFERENCE_ALREADY_REVERSED with one DEBIT', async () => {
    const wallet = await openWallet('100.00');
    const win = await applied(wager(wallet, 'WIN', '50.00'));
    const bet = await applied(wager(wallet, 'BET', '20.00'));
    const refund = await applied(referencing(wallet, 'REFUND', '20.00', bet.body));
    const first = [
      await applied(referencing(wallet, 'ROLLBACK', '50.00', win.body)),
      await applied(referencing(wallet, 'ROLLBACK', '20.00', refund.body)),
    ];
    // 100 + 50 - 20 + 20 - 50 - 20
    const state = { balance: '80.00', version: 6 };

    for (const [reference, amount] of [
      [win.body, '50.00'],
      [refund.body, '20.00'],
    ] as const) {
      await expectRejected(
        await submit(referencing(wallet, 'ROLLBACK', amount, reference)),
        wallet,
        'REFERENCE_ALREADY_REVERSED',
        { amount: '80.00', currency: 'BRL' },
        state,
      );
    }
    const debits = await sql`
      select count(*)::int as count from wallet_ledger_entries
       where wallet_id = ${wallet.id} and direction = 'DEBIT'
         and transaction_id in (${first[0]?.result.transactionId}, ${first[1]?.result.transactionId})`;
    expect(debits[0]?.count).toBe(2);
    // Opening, WIN, BET, REFUND and the two first ROLLBACKs: the rejections wrote none.
    expect(await rowCounts(wallet.id)).toMatchObject({ entries: 6 });
  });

  test('rollback of a spent WIN is 422 REVERSAL_WOULD_OVERDRAW', async () => {
    const wallet = await openWallet('10.00');
    const win = await applied(wager(wallet, 'WIN', '50.00'));
    await applied(wager(wallet, 'BET', '55.00'));

    await expectRejected(
      await submit(referencing(wallet, 'ROLLBACK', '50.00', win.body)),
      wallet,
      'REVERSAL_WOULD_OVERDRAW',
      { amount: '5.00', currency: 'BRL' },
      { balance: '5.00', version: 3 },
    );
  });

  test('REFUND of a WIN and WIN of a WIN are 422 REFERENCE_KIND_NOT_ALLOWED', async () => {
    const wallet = await openWallet('100.00');
    const win = await applied(wager(wallet, 'WIN', '20.00'));

    for (const kind of ['REFUND', 'WIN']) {
      await expectRejected(
        await submit(referencing(wallet, kind, '20.00', win.body)),
        wallet,
        'REFERENCE_KIND_NOT_ALLOWED',
        { amount: '120.00', currency: 'BRL' },
        { balance: '120.00', version: 2 },
      );
    }
  });

  test('a reference in another round or another wallet is 422 REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet('100.00');
    const stranger = await openWallet('100.00');
    const bet = await applied(wager(wallet, 'BET', '30.00'));
    const strangersBet = await applied(wager(stranger, 'BET', '30.00'));
    const state = { balance: '70.00', version: 2 };
    const balance = { amount: '70.00', currency: 'BRL' };

    await expectRejected(
      await submit(referencing(wallet, 'REFUND', '30.00', bet.body, { roundId: 'round-2' })),
      wallet,
      'REFERENCE_MISMATCH',
      balance,
      state,
    );
    await expectRejected(
      await submit(referencing(wallet, 'REFUND', '30.00', strangersBet.body)),
      wallet,
      'REFERENCE_MISMATCH',
      balance,
      state,
    );
    expect(await walletRow(stranger.id)).toEqual(state);
  });

  test('REFUND of a rejected BET is 422 REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet, 'BET', '500.00');
    expect((await submit(bet)).status).toBe(422);

    await expectRejected(
      await submit(referencing(wallet, 'REFUND', '500.00', bet)),
      wallet,
      'REFERENCE_NOT_PROCESSED',
      { amount: '100.00', currency: 'BRL' },
      { balance: '100.00', version: 1 },
    );
  });

  test('a REFUND of another amount is 422 REFERENCE_AMOUNT_MISMATCH', async () => {
    const wallet = await openWallet('100.00');
    const bet = await applied(wager(wallet, 'BET', '30.00'));

    await expectRejected(
      await submit(referencing(wallet, 'REFUND', '29.99', bet.body)),
      wallet,
      'REFERENCE_AMOUNT_MISMATCH',
      { amount: '70.00', currency: 'BRL' },
      { balance: '70.00', version: 2 },
    );
  });
});

/** 202, nothing moved, and the row waits, due at once for the worker of S7. */
async function expectWaiting(response: Response, wallet: Wallet, balance: string, version: number) {
  expect(response.status).toBe(202);
  const result = (await response.json()) as Result;
  expect(result).toEqual({
    transactionId: expect.stringMatching(UUID_V7),
    status: 'PENDING_REFERENCE',
    balance: { amount: balance, currency: 'BRL' },
    idempotentReplay: false,
  });
  expect(await walletRow(wallet.id)).toEqual({ balance, version });
  expect(await entriesOf(result.transactionId)).toEqual([]);
  const [row] = await sql`
    select status, reference_transaction_id, next_attempt_at is not null as due
      from wager_transactions where id = ${result.transactionId}`;
  expect(row).toEqual({ status: 'PENDING_REFERENCE', reference_transaction_id: null, due: true });
  return result;
}

describe('POST /wagering/transactions — reference not found yet (S6 Q1, L-10)', () => {
  test('a REFUND whose reference does not exist is 202 PENDING_REFERENCE, and its replay is 202 again', async () => {
    const wallet = await openWallet('100.00');
    const refund = wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: 'tx-later' });

    const first = await expectWaiting(await submit(refund), wallet, '100.00', 1);
    const replay = await submit(refund);

    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ...first, idempotentReplay: true });
  });

  test('a ROLLBACK of a REFUND that is still PENDING_REFERENCE waits too', async () => {
    const wallet = await openWallet('100.00');
    const refund = wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: 'tx-later' });
    await expectWaiting(await submit(refund), wallet, '100.00', 1);

    await expectWaiting(
      await submit(referencing(wallet, 'ROLLBACK', '30.00', refund)),
      wallet,
      '100.00',
      1,
    );
  });
});
