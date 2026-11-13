import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { type AppProcesses, startProcesses } from '../support/processes';
import { newId } from '../support/schema-fixtures';

let processes: AppProcesses;
let sql: SQL;

beforeAll(async () => {
  sql = await migratedDatabase();
  // The pending-reference worker of every process runs at test speed (R-70); nothing else waits.
  processes = await startProcesses(3, {
    PENDING_REFERENCE_BASE_DELAY_MS: '50',
    PENDING_REFERENCE_MAX_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_ATTEMPTS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '20',
    PENDING_REFERENCE_BATCH_SIZE: '50',
  });
}, 30_000);

afterAll(async () => {
  try {
    await expectLedgerInvariant(sql);
  } finally {
    await processes?.stop();
    await sql.close();
  }
}, 30_000);

const PROVIDER = 'provider-s5';

interface Wallet {
  id: string;
  playerId: string;
}

/** The URL of process `i`, round-robin, so consecutive requests land on different processes. */
const via = (i: number): string => processes.urls[i % processes.urls.length] as string;

async function openWallet(url: string, amount = '100.00'): Promise<Wallet> {
  const response = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: `player-${newId()}`,
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Wallet;
}

type Body = Record<string, unknown>;

function bet(wallet: Wallet, amount: string, externalTransactionId = `tx-${newId()}`): Body {
  return {
    providerId: PROVIDER,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

interface Answer {
  status: number;
  body: { transactionId: string; status: string; failureCode?: string; [field: string]: unknown };
}

/** Sends `body` with the recommended key `{providerId}:{externalTransactionId}` unless `key` is given. */
async function submit(
  url: string,
  body: Body,
  key = `${body.providerId}:${body.externalTransactionId}`,
): Promise<Answer> {
  const response = await fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Answer['body'] };
}

async function walletState(walletId: string) {
  const [row] = await sql`
    select w.balance, w.version,
           (select count(*)::int from wager_transactions t where t.wallet_id = w.id and t.kind = 'BET')
             as bets,
           (select count(*)::int from wallet_ledger_entries e
             where e.wallet_id = w.id and e.direction = 'DEBIT') as debits,
           (select count(*)::int from outbox_messages o where o.aggregate_id = w.id) as events
      from wallets w where w.id = ${walletId}`;
  return row;
}

const count = <T>(items: T[], match: (item: T) => boolean): number => items.filter(match).length;

describe('three application processes', () => {
  test('three separate application processes are ready and each one serves requests', async () => {
    expect(new Set(processes.pids).size).toBe(3);
    expect(processes.pids).not.toContain(process.pid);

    for (const [i, url] of processes.urls.entries()) {
      const wallet = await openWallet(url);
      for (const other of [via(i + 1), via(i + 2)]) {
        const response = await fetch(`${other}/wallets/${wallet.id}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: wallet.id, playerId: wallet.playerId });
      }
    }
  });
});

describe('one wallet, many processes', () => {
  test('the same bet sent 50 times in parallel across three processes debits once', async () => {
    const wallet = await openWallet(via(0));
    const body = bet(wallet, '25.00');

    const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(via(i), body)));

    expect(count(answers, (a) => a.status === 200)).toBe(50);
    expect(new Set(answers.map((a) => a.body.transactionId)).size).toBe(1);
    expect(count(answers, (a) => a.body.idempotentReplay === false)).toBe(1);
    for (const { body: answer } of answers) {
      expect(answer).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
      });
    }
    // Opening: 2 events; the bet: 2 more. No replay writes an event.
    expect(await walletState(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
      bets: 1,
      debits: 1,
      events: 4,
    });
  }, 30_000);

  test('one key with two payloads sent in parallel to different processes: one 200, one 409 IDEMPOTENCY_KEY_CONFLICT, one debit', async () => {
    const wallet = await openWallet(via(0));
    const first = bet(wallet, '25.00');
    const second = { ...first, money: { amount: '26.00', currency: 'BRL' } };
    const key = `${first.providerId}:${first.externalTransactionId}`;

    const answers = await Promise.all([submit(via(0), first, key), submit(via(1), second, key)]);

    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)?.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    });
    const applied = answers.find((a) => a.status === 200)?.body.balance as { amount: string };
    expect(['75.00', '74.00']).toContain(applied.amount);
    expect(await walletState(wallet.id)).toMatchObject({
      balance: applied.amount,
      version: 2,
      bets: 1,
      debits: 1,
      events: 4,
    });
  }, 30_000);

  test('balance 100 and two bets of 80 on different processes: one PROCESSED, one REJECTED, balance 20, one debit (20 wallets at once)', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => openWallet(via(i))));

    const answers = await Promise.all(
      wallets.map((wallet, i) =>
        Promise.all([
          submit(via(i), bet(wallet, '80.00')),
          submit(via(i + 1), bet(wallet, '80.00')),
        ]),
      ),
    );

    for (const [i, pair] of answers.entries()) {
      const wallet = wallets[i] as Wallet;
      const statuses = pair.map((a) => a.status).sort();
      expect({ wallet: wallet.id, statuses }).toEqual({ wallet: wallet.id, statuses: [200, 422] });
      expect(pair.find((a) => a.status === 422)?.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '20.00', currency: 'BRL' },
      });
      // Opening 2 events, the applied bet 2, the rejected one 1.
      expect(await walletState(wallet.id)).toEqual({
        balance: '20.00',
        version: 2,
        bets: 2,
        debits: 1,
        events: 5,
      });
    }
  }, 30_000);

  test('60 bets of 5.00 on a wallet of 100: exactly 20 applied, 40 INSUFFICIENT_FUNDS, balance 0.00, never negative', async () => {
    const wallet = await openWallet(via(0));

    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, i) => submit(via(i), bet(wallet, '5.00'))),
    );

    const applied = answers.filter((a) => a.status === 200);
    expect(applied).toHaveLength(20);
    expect(
      count(answers, (a) => a.status === 422 && a.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toBe(40);
    // Each applied debit saw a different balance: 95.00, 90.00, … 0.00, once each. Two debits that
    // read the same balance would repeat a value and skip another.
    // Compared as strings: money never becomes a `number`, not even in a test.
    const observed = applied.map((a) => (a.body.balance as { amount: string }).amount).sort();
    expect(observed).toEqual(Array.from({ length: 20 }, (_, i) => `${95 - 5 * i}.00`).sort());
    expect(await walletState(wallet.id)).toMatchObject({
      balance: '0.00',
      version: 21,
      bets: 60,
      debits: 20,
    });
  }, 30_000);
});

describe('distinct wallets, in parallel', () => {
  test('a wallet held locked does not delay a bet on another wallet', async () => {
    const [locked, free] = (await Promise.all([openWallet(via(0)), openWallet(via(1))])) as [
      Wallet,
      Wallet,
    ];
    let lockedAnswer: Promise<Answer> | undefined;
    let lockedSettled = false;

    await sql.begin(async (tx) => {
      const [{ holder }] = await tx`
        select pg_backend_pid() as holder from wallets where id = ${locked.id} for update`;
      lockedAnswer = submit(via(0), bet(locked, '10.00')).finally(() => {
        lockedSettled = true;
      });
      await waitForSessionBlockedBy(holder);

      const other = await submit(via(1), bet(free, '10.00'));

      expect(other.status).toBe(200);
      expect(lockedSettled).toBe(false);
    });

    expect((await lockedAnswer)?.status).toBe(200);
    expect(await walletState(locked.id)).toMatchObject({ balance: '90.00', version: 2 });
    expect(await walletState(free.id)).toMatchObject({ balance: '90.00', version: 2 });
  }, 30_000);

  test('30 wallets with 10 bets each, all in parallel across three processes, all end at 90.00 and version 11', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, (_, i) => openWallet(via(i))));

    const answers = await Promise.all(
      wallets.flatMap((wallet, w) =>
        Array.from({ length: 10 }, (_, i) => submit(via(w + i), bet(wallet, '1.00'))),
      ),
    );

    expect(count(answers, (a) => a.status === 200)).toBe(300);
    for (const wallet of wallets) {
      expect({ wallet: wallet.id, ...(await walletState(wallet.id)) }).toMatchObject({
        wallet: wallet.id,
        balance: '90.00',
        version: 11,
        bets: 10,
        debits: 10,
      });
    }
  }, 30_000);
});

/** A reversal of `reference` with its own external id, hence its own idempotency key. */
function reversal(reference: Body, kind: 'REFUND' | 'ROLLBACK'): Body {
  return {
    ...reference,
    externalTransactionId: `tx-${newId()}`,
    kind,
    referenceExternalTransactionId: reference.externalTransactionId,
  };
}

async function reversalsOf(walletId: string) {
  const [row] = await sql`
    select (select count(*)::int from wager_transactions
             where wallet_id = ${walletId} and kind in ('REFUND', 'ROLLBACK')
               and status = 'PROCESSED') as processed,
           (select count(*)::int from wallet_ledger_entries
             where wallet_id = ${walletId} and direction = 'CREDIT') as credits`;
  return row;
}

describe('reversals across processes (S6)', () => {
  test('the same BET refunded under 20 different keys across three processes is credited once', async () => {
    const wallet = await openWallet(via(0));
    const placed = bet(wallet, '30.00');
    expect((await submit(via(0), placed)).status).toBe(200);

    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => submit(via(i), reversal(placed, 'REFUND'))),
    );

    expect(count(answers, (a) => a.status === 200)).toBe(1);
    expect(
      count(
        answers,
        (a) => a.status === 422 && a.body.failureCode === 'REFERENCE_ALREADY_REVERSED',
      ),
    ).toBe(19);
    // The opening is the wallet's first credit; the refund is the only other one.
    expect(await reversalsOf(wallet.id)).toEqual({ processed: 1, credits: 2 });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '100.00', version: 3 });
  }, 30_000);

  test('a REFUND and a ROLLBACK of the same BET in parallel: one PROCESSED, one REFERENCE_ALREADY_REVERSED', async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await openWallet(via(round));
      const placed = bet(wallet, '30.00');
      expect((await submit(via(round), placed)).status).toBe(200);

      const answers = await Promise.all([
        submit(via(round + 1), reversal(placed, 'REFUND')),
        submit(via(round + 2), reversal(placed, 'ROLLBACK')),
      ]);

      expect(answers.map((a) => a.status).sort()).toEqual([200, 422]);
      expect(answers.find((a) => a.status === 422)?.body.failureCode).toBe(
        'REFERENCE_ALREADY_REVERSED',
      );
      expect(await reversalsOf(wallet.id)).toEqual({ processed: 1, credits: 2 });
      expect(await walletState(wallet.id)).toMatchObject({ balance: '100.00', version: 3 });
    }
  }, 30_000);
});

/** Waits until PostgreSQL shows a session blocked by the lock that session `holder` holds. */
async function waitForSessionBlockedBy(holder: number): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const [{ waiting }] = await sql`
      select count(*)::int as waiting from pg_stat_activity
       where ${holder}::int = any(pg_blocking_pids(pid))`;
    if (waiting > 0) return;
    if (performance.now() > deadline) throw new Error('the bet on the locked wallet never waited');
    await Bun.sleep(10);
  }
}

describe('references delivered late, across processes (S7, R-70)', () => {
  test('REFUNDs and ROLLBACKs sent before their BETs across three processes are applied exactly once after the BETs arrive', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => openWallet(via(i))));
    const scenarios = wallets.map((wallet) => {
      const refunded = bet(wallet, '30.00');
      const rolledBack = bet(wallet, '20.00');
      return {
        wallet,
        bets: [refunded, rolledBack],
        // Three REFUNDs of one BET under different ids, one per process: only one may apply.
        reversals: [
          reversal(refunded, 'REFUND'),
          reversal(refunded, 'REFUND'),
          reversal(refunded, 'REFUND'),
          reversal(rolledBack, 'ROLLBACK'),
        ],
      };
    });

    const early = await Promise.all(
      scenarios.flatMap(({ reversals }) => reversals.map((body, i) => submit(via(i), body))),
    );
    expect(early.every((a) => a.status === 202 && a.body.status === 'PENDING_REFERENCE')).toBe(
      true,
    );
    const placed = await Promise.all(
      scenarios.flatMap(({ bets }) => bets.map((body, i) => submit(via(i + 1), body))),
    );
    expect(placed.every((a) => a.status === 200)).toBe(true);

    const ids = wallets.map(({ id }) => id);
    const deadline = performance.now() + 20_000;
    for (;;) {
      const [{ waiting }] = await sql`
        select count(*)::int as waiting from wager_transactions
         where wallet_id in ${sql(ids)} and status = 'PENDING_REFERENCE'`;
      if (waiting === 0) break;
      if (performance.now() > deadline) throw new Error(`${waiting} rows still waiting`);
      await Bun.sleep(20);
    }

    for (const { wallet } of scenarios) {
      const outcomes = await sql`
        select kind, status, failure_code, count(*)::int as count from wager_transactions
         where wallet_id = ${wallet.id} and kind in ('REFUND', 'ROLLBACK')
         group by kind, status, failure_code order by kind, status`;
      expect(outcomes).toEqual([
        { kind: 'REFUND', status: 'PROCESSED', failure_code: null, count: 1 },
        {
          kind: 'REFUND',
          status: 'REJECTED',
          failure_code: 'REFERENCE_ALREADY_REVERSED',
          count: 2,
        },
        { kind: 'ROLLBACK', status: 'PROCESSED', failure_code: null, count: 1 },
      ]);
      // 100 − 30 − 20 + 30 + 20; opening, two BETs, one REFUND, one ROLLBACK.
      expect(await walletState(wallet.id)).toMatchObject({ balance: '100.00', version: 5 });
      expect(await reversalsOf(wallet.id)).toEqual({ processed: 2, credits: 3 });
    }
  }, 40_000);
});
