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

const PROVIDER = 'provider-s8';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Wallet {
  id: string;
  playerId: string;
}

type Body = Record<string, unknown>;

async function openWallet(amount = '100.00'): Promise<Wallet> {
  const response = await fetch(`${app.url}/wallets`, {
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

async function submit(body: Body): Promise<{ status: number; result: Body }> {
  const response = await fetch(`${app.url}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: (await response.json()) as Body };
}

async function get(path: string): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${app.url}${path}`);
  return { status: response.status, body: (await response.json()) as Body };
}

const byId = (id: string) => get(`/wagering/transactions/${id}`);
const byExternalId = (providerId: string, externalId: string) =>
  get(
    `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalId)}`,
  );

interface LedgerPage {
  items: { sequence: number; [field: string]: unknown }[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function ledgerPage(walletId: string, query = ''): Promise<LedgerPage> {
  const { status, body } = await get(`/wallets/${walletId}/ledger${query}`);
  expect(status).toBe(200);
  return body as unknown as LedgerPage;
}

/** Every entry of the wallet, page after page from the start. */
async function walkLedger(walletId: string, limit: number): Promise<number[]> {
  const sequences: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query: string = `?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`;
    const page = await ledgerPage(walletId, query);
    sequences.push(...page.items.map((item) => item.sequence));
    cursor = page.nextCursor;
    if (!page.hasMore) return sequences;
  }
}

/** Waits until a session is blocked by `holder`, the backend holding the wallet lock. */
async function waitForSessionBlockedBy(holder: number): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const [{ waiting }] = await sql`
      select count(*)::int as waiting from pg_stat_activity
       where ${holder}::int = any(pg_blocking_pids(pid))`;
    if (waiting > 0) return;
    if (performance.now() > deadline)
      throw new Error('the write on the locked wallet never waited');
    await Bun.sleep(10);
  }
}

function reconcile(walletId: string) {
  return fetch(`${app.url}/wallets/${walletId}/reconciliation`, { method: 'POST' });
}

describe('GET a transaction by id and by provider + external id (R-44)', () => {
  test('a processed, a rejected and a waiting transaction read the same by id and by provider + external id', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet, 'BET', '25.00');
    const mismatch = wager(wallet, 'BET', '5.00', { playerId: `player-${newId()}` });
    const missingBet = `tx-${newId()}`;
    const refund = wager(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: missingBet });

    const submitted = [await submit(bet), await submit(mismatch), await submit(refund)];
    expect(submitted.map((s) => s.status)).toEqual([200, 422, 202]);
    const [betId, mismatchId, refundId] = submitted.map((s) => s.result.transactionId as string);

    const common = (body: Body) => ({
      providerId: PROVIDER,
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      playerId: body.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: body.kind,
      money: body.money,
      createdAt: expect.stringMatching(ISO_TIME),
    });
    const expected = [
      {
        transactionId: betId,
        ...common(bet),
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        processedAt: expect.stringMatching(ISO_TIME),
      },
      {
        // L-20: no balance for a wallet that is not the caller's, on reads as on POST.
        transactionId: mismatchId,
        ...common(mismatch),
        status: 'REJECTED',
        failureCode: 'WALLET_PLAYER_MISMATCH',
      },
      {
        transactionId: refundId,
        ...common(refund),
        referenceExternalTransactionId: missingBet,
        status: 'PENDING_REFERENCE',
        balance: { amount: '75.00', currency: 'BRL' },
      },
    ];

    for (const [index, body] of [bet, mismatch, refund].entries()) {
      const id = await byId(submitted[index]?.result.transactionId as string);
      const external = await byExternalId(PROVIDER, body.externalTransactionId as string);
      expect(id).toEqual({ status: 200, body: expected[index] as Body });
      expect(external).toEqual(id);
    }

    // The BET arrives: the waiting REFUND is resolvable by any worker, so the row is not stranded.
    expect(
      (await submit(wager(wallet, 'BET', '10.00', { externalTransactionId: missingBet }))).status,
    ).toBe(200);
  });

  test('a resolved reference is read with its transaction id', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet, 'BET', '30.00');
    const { result } = await submit(bet);
    const refund = wager(wallet, 'REFUND', '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const { status } = await submit(refund);
    expect(status).toBe(200);

    const read = await byExternalId(PROVIDER, refund.externalTransactionId as string);

    expect(read.body).toMatchObject({
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: result.transactionId,
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  test('an unknown transaction is 404 TRANSACTION_NOT_FOUND', async () => {
    for (const read of [await byId(newId()), await byExternalId(PROVIDER, `tx-${newId()}`)]) {
      expect(read).toEqual({
        status: 404,
        body: { code: 'TRANSACTION_NOT_FOUND', message: expect.any(String) },
      });
    }
  });

  test('an invalid id is 400 VALIDATION_ERROR', async () => {
    for (const read of [
      await byId('not-a-uuid'),
      await byExternalId(PROVIDER, 'x'.repeat(129)),
      await byExternalId('p'.repeat(129), 'tx-1'),
    ]) {
      expect(read.status).toBe(400);
      expect(read.body.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /wallets/:walletId/ledger (R-45)', () => {
  test('pages a wallet ledger in sequence order and resumes from nextCursor', async () => {
    const wallet = await openWallet('100.00');
    const bet = await submit(wager(wallet, 'BET', '25.00'));
    await submit(wager(wallet, 'WIN', '40.00'));
    await submit(wager(wallet, 'BET', '5.00'));

    const first = await ledgerPage(wallet.id, '?limit=2');
    expect(first.hasMore).toBe(true);
    expect(first.items).toEqual([
      {
        entryId: expect.any(String),
        transactionId: expect.any(String),
        direction: 'CREDIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        sequence: 1,
        createdAt: expect.stringMatching(ISO_TIME),
      },
      {
        entryId: expect.any(String),
        transactionId: bet.result.transactionId,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        sequence: 2,
        createdAt: expect.stringMatching(ISO_TIME),
      },
    ]);

    // The OPENING behind the first entry is readable like any transaction (S8 review, m6).
    const opening = await byId(first.items[0]?.transactionId as string);
    expect(opening.body).toMatchObject({
      providerId: 'SYSTEM',
      externalTransactionId: `opening:${wallet.id}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      money: { amount: '100.00', currency: 'BRL' },
    });
    expect(await byExternalId('SYSTEM', `opening:${wallet.id}`)).toEqual(opening);

    const second = await ledgerPage(wallet.id, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.sequence)).toEqual([3, 4]);
    expect(second.hasMore).toBe(false);

    // The last page keeps a cursor: a later write is read from where the reader stopped.
    await submit(wager(wallet, 'WIN', '1.00'));
    const resumed = await ledgerPage(wallet.id, `?cursor=${second.nextCursor}`);
    expect(resumed.items.map((item) => item.sequence)).toEqual([5]);
    const empty = await ledgerPage(wallet.id, `?cursor=${resumed.nextCursor}`);
    expect(empty).toEqual({ items: [], nextCursor: resumed.nextCursor, hasMore: false });
  });

  test('the default page is 50 entries', async () => {
    const wallet = await openWallet('100.00');
    for (let i = 0; i < 50; i++) await submit(wager(wallet, 'WIN', '1.00'));

    const page = await ledgerPage(wallet.id);

    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  test('a wallet opened at zero starts at sequence 2, and an untouched one has an empty ledger', async () => {
    const wallet = await openWallet('0.00');
    expect(await ledgerPage(wallet.id)).toEqual({ items: [], nextCursor: null, hasMore: false });

    await submit(wager(wallet, 'WIN', '10.00'));

    expect((await ledgerPage(wallet.id)).items.map((item) => item.sequence)).toEqual([2]);
  });

  test('an unknown wallet is 404, and a bad cursor, a cursor of another wallet or a bad limit is 400', async () => {
    const wallet = await openWallet('100.00');
    const other = await openWallet('100.00');
    const otherCursor = (await ledgerPage(other.id, '?limit=1')).nextCursor;
    expect((await get(`/wallets/${newId()}/ledger`)).body.code).toBe('WALLET_NOT_FOUND');
    expect((await get(`/wallets/${newId()}/ledger`)).status).toBe(404);
    expect((await get('/wallets/not-a-uuid/ledger')).status).toBe(400);
    for (const query of [
      `?cursor=${otherCursor}`,
      '?cursor=***',
      `?cursor=${Buffer.from('0').toString('base64url')}`,
      '?limit=0',
      '?limit=201',
      '?limit=1.5',
      '?limit=ten',
    ]) {
      const read = await get(`/wallets/${wallet.id}/ledger${query}`);
      expect(read.status).toBe(400);
      expect(read.body.code).toBe('VALIDATION_ERROR');
    }
  });

  test('the cursor walks every entry once while the wallet is written', async () => {
    const wallet = await openWallet('1000.00');
    const sequences: number[] = [];
    let cursor: string | null = null;
    // Each page is followed by three parallel writes that commit before the next page: the walk is
    // in progress while the wallet grows, by construction, not by timing (S8 review, m1).
    for (let round = 0; round < 10; round++) {
      const query: string = `?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = await ledgerPage(wallet.id, query);
      sequences.push(...page.items.map((item) => item.sequence));
      cursor = page.nextCursor;
      const writes = await Promise.all(
        Array.from({ length: 3 }, (_, i) => submit(wager(wallet, i === 0 ? 'BET' : 'WIN', '1.00'))),
      );
      expect(writes.map((write) => write.status)).toEqual([200, 200, 200]);
    }
    let page: LedgerPage;
    do {
      page = await ledgerPage(wallet.id, `?limit=3&cursor=${cursor}`);
      sequences.push(...page.items.map((item) => item.sequence));
      cursor = page.nextCursor;
    } while (page.hasMore);

    // Strictly ascending and gap-free from 1 to the last entry: nothing seen twice, nothing skipped.
    expect(sequences).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(await walkLedger(wallet.id, 7)).toEqual(sequences);
  });

  test('reads never wait for the wallet lock', async () => {
    const wallet = await openWallet('100.00');
    const { result } = await submit(wager(wallet, 'BET', '10.00'));
    let held: Promise<{ status: number }> | undefined;
    let heldSettled = false;

    await sql.begin(async (tx) => {
      const [{ holder }] = await tx`
        select pg_backend_pid() as holder from wallets where id = ${wallet.id} for update`;
      held = submit(wager(wallet, 'BET', '5.00')).finally(() => {
        heldSettled = true;
      });
      await waitForSessionBlockedBy(holder);

      // A read that took the wallet lock would wait here until the timeout (S8 review, m3).
      const reads = await Promise.all([
        fetch(`${app.url}/wallets/${wallet.id}/ledger`, { signal: AbortSignal.timeout(2000) }),
        fetch(`${app.url}/wallets/${wallet.id}/reconciliation`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        }),
        fetch(`${app.url}/wagering/transactions/${result.transactionId}`, {
          signal: AbortSignal.timeout(2000),
        }),
      ]);

      expect(reads.map((read) => read.status)).toEqual([200, 200, 200]);
      expect(await reads[1]?.json()).toMatchObject({ consistent: true, checkedEntries: 2 });
      expect(heldSettled).toBe(false);
    });

    expect((await held)?.status).toBe(200);
  });
});

describe('POST /wallets/:walletId/reconciliation (R-49)', () => {
  test('a consistent wallet reconciles with difference 0.00 and its entry count', async () => {
    const wallet = await openWallet('1000.00');
    await submit(wager(wallet, 'BET', '25.00'));
    await submit(wager(wallet, 'LOSS', '0.00'));

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('a wallet opened at zero checks 0 entries; an unknown wallet is 404', async () => {
    const wallet = await openWallet('0.00');
    expect(await (await reconcile(wallet.id)).json()).toMatchObject({
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
    expect((await reconcile(newId())).status).toBe(404);
    expect((await reconcile('not-a-uuid')).status).toBe(400);
  });

  test('a balance tampered through SQL is reported, logged and counted, and not fixed', async () => {
    const wallet = await openWallet('100.00');
    await submit(wager(wallet, 'BET', '25.00'));
    const before = await app.metricValue('wallet_reconciliation_divergences_total');
    await sql`update wallets set balance = 50.00 where id = ${wallet.id}`;
    try {
      const response = await reconcile(wallet.id);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '50.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '-25.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 2,
      });
      expect(await app.metricValue('wallet_reconciliation_divergences_total')).toBe(before + 1);
      const logged = app
        .logs()
        .filter((line) => line.message === 'wallet reconciliation divergence');
      expect(logged).toEqual([
        expect.objectContaining({ level: 'error', walletId: wallet.id, checkedEntries: 2 }),
      ]);
      // No amount reaches the log line (CLAUDE.md, logs).
      expect(JSON.stringify(logged)).not.toContain('50.00');
      expect(JSON.stringify(logged)).not.toContain('75.00');
      // Never fixed: the stored balance is still the tampered one.
      const [row] = await sql`select balance from wallets where id = ${wallet.id}`;
      expect(row.balance).toBe('50.00');
    } finally {
      // The test, not the service, undoes its own tampering before the ledger invariant runs.
      await sql`update wallets set balance = 75.00 where id = ${wallet.id}`;
    }
    expect(await (await reconcile(wallet.id)).json()).toMatchObject({ consistent: true });
  });

  test('reconciliation never reports a divergence while the wallet is written', async () => {
    const wallet = await openWallet('1000.00');
    let writing = true;
    const writes = Promise.all(
      Array.from({ length: 20 }, () => submit(wager(wallet, 'BET', '1.00'))),
    ).finally(() => {
      writing = false;
    });
    // Three readers reconcile back to back for as long as the writes last.
    const readers = Array.from({ length: 3 }, async () => {
      const seen: Body[] = [];
      while (writing) seen.push((await (await reconcile(wallet.id)).json()) as Body);
      return seen;
    });
    const statuses = (await writes).map((write) => write.status);
    const reconciliations = (await Promise.all(readers)).flat();

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(reconciliations.every((result) => result.consistent === true)).toBe(true);
    // More than one stored balance: the reads did overlap the writes (S8 review, m2).
    const balances = new Set(
      reconciliations.map((result) => (result.storedBalance as { amount: string }).amount),
    );
    expect(balances.size).toBeGreaterThan(1);
  });
});
