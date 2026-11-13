import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import {
  toLedgerEntry,
  toLedgerEntryRecord,
  toWagerTransaction,
  toWagerTransactionRecord,
  toWallet,
  toWalletRecord,
} from '../../src/infrastructure/persistence/mappers';
import {
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../src/infrastructure/persistence/records';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { fundingAccountId, newId } from '../support/schema-fixtures';

let sql: SQL;
let orm: MikroORM;

beforeAll(async () => {
  sql = await migratedDatabase();
  orm = await startOrm();
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await orm.close();
  await sql.close();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const OPENED_AT = new Date('2026-11-13T12:00:00.123Z');
const REJECTED_AT = new Date('2026-11-13T12:00:01.456Z');

/** A wallet opened with a balance, its OPENING transaction and entry, and a rejected BET. */
function scenario() {
  const walletId = newId();
  const openingId = newId();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: `player-${newId()}`,
    initialBalance: brl('100.00'),
    openingTransactionId: openingId,
    openingEntryId: newId(),
    at: OPENED_AT,
  });
  if (openingEntry === undefined) throw new Error('expected an opening entry');

  const opening = WagerTransaction.create({
    id: openingId,
    providerId: 'SYSTEM',
    externalTransactionId: `opening:${walletId}`,
    idempotencyKey: `opening:${walletId}`,
    payloadHash: 'b'.repeat(64),
    walletId,
    playerId: wallet.playerId,
    roundId: 'OPENING',
    gameId: 'OPENING',
    kind: WagerTransactionKind.Opening,
    money: wallet.balance,
    createdAt: OPENED_AT,
  });
  opening.markProcessed(undefined, wallet.balance, OPENED_AT);

  const rejected = WagerTransaction.create({
    id: newId(),
    providerId: 'provider-a',
    externalTransactionId: `bet-${newId()}`,
    idempotencyKey: `key-${newId()}`,
    payloadHash: 'c'.repeat(64),
    walletId,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('500.00'),
    createdAt: REJECTED_AT,
  });
  rejected.reject(FailureCode.InsufficientFunds, wallet.balance);

  return { wallet, openingEntry, opening, rejected };
}

async function persist(s: ReturnType<typeof scenario>): Promise<void> {
  const funding = await fundingAccountId(sql, 'BRL');
  const em = orm.em.fork();
  await em.transactional(async (tx) => {
    tx.persist(tx.create(WalletRecord, toWalletRecord(s.wallet)));
    await tx.flush();
    tx.persist(tx.create(WagerTransactionRecord, toWagerTransactionRecord(s.opening)));
    tx.persist(tx.create(WagerTransactionRecord, toWagerTransactionRecord(s.rejected)));
    await tx.flush();
    tx.persist(tx.create(LedgerEntryRecord, toLedgerEntryRecord(s.openingEntry, funding)));
  });
}

describe('persistence mappers', () => {
  test('a wallet, a transaction and an entry round-trip through their records unchanged', async () => {
    const s = scenario();
    await persist(s);

    const em = orm.em.fork();
    const wallet = toWallet(await em.findOneOrFail(WalletRecord, s.wallet.id));
    const opening = toWagerTransaction(
      await em.findOneOrFail(WagerTransactionRecord, s.opening.id),
    );
    const rejected = toWagerTransaction(
      await em.findOneOrFail(WagerTransactionRecord, s.rejected.id),
    );
    const entry = toLedgerEntry(await em.findOneOrFail(LedgerEntryRecord, s.openingEntry.id));

    expect(wallet).toStrictEqual(s.wallet);
    expect(opening).toStrictEqual(s.opening);
    expect(rejected).toStrictEqual(s.rejected);
    expect(entry).toStrictEqual(s.openingEntry);
  });

  test('a NULL column comes back as undefined, never null', async () => {
    const s = scenario();
    await persist(s);

    const em = orm.em.fork();
    const opening = toWagerTransaction(
      await em.findOneOrFail(WagerTransactionRecord, s.opening.id),
    );
    const rejected = toWagerTransaction(
      await em.findOneOrFail(WagerTransactionRecord, s.rejected.id),
    );

    for (const transaction of [opening, rejected]) {
      expect(transaction.referenceExternalTransactionId).toBeUndefined();
      expect(transaction.referenceTransactionId).toBeUndefined();
    }
    expect(opening.failureCode).toBeUndefined();
    expect(rejected.processedAt).toBeUndefined();
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('a PENDING_REFERENCE transaction is stored due at once and read back (S6, Q1)', async () => {
    const s = scenario();
    await persist(s);
    const waiting = WagerTransaction.create({
      id: newId(),
      providerId: 'provider-a',
      externalTransactionId: `refund-${newId()}`,
      idempotencyKey: `key-${newId()}`,
      payloadHash: 'd'.repeat(64),
      walletId: s.wallet.id,
      playerId: s.wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: brl('10.00'),
      referenceExternalTransactionId: 'bet-not-yet',
      createdAt: REJECTED_AT,
    });
    waiting.markPendingReference(s.wallet.balance);

    const em = orm.em.fork();
    await em.insert(WagerTransactionRecord, toWagerTransactionRecord(waiting));

    const [row] = await sql`
      select next_attempt_at, reference_attempts from wager_transactions where id = ${waiting.id}`;
    expect(row).toEqual({ next_attempt_at: REJECTED_AT, reference_attempts: 0 });
    expect(
      toWagerTransaction(await em.findOneOrFail(WagerTransactionRecord, waiting.id)),
    ).toStrictEqual(waiting);
  });
});
