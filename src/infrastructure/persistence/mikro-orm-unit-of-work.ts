import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import type { IdGenerator, TransactionScope, UnitOfWork } from '../../application/ports';
import { ID_GENERATOR } from '../../application/tokens';
import { LedgerAccountKind, type LedgerCounterparty } from '../../domain/ledger-account';
import {
  toLedgerEntryRecord,
  toOutboxMessageRecord,
  toWagerTransaction,
  toWagerTransactionRecord,
  toWallet,
  toWalletRecord,
} from './mappers';
import {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/**
 * Unique constraints whose violation is an answer, not a bug, mapped by name (S2 named every one).
 * MikroORM's `DriverException` copies the properties of the `pg` error, `constraint` included.
 */
const CONFLICTS: Readonly<Record<string, () => Error>> = {
  wallets_player_currency_key: () => new WalletAlreadyExistsError(),
  // Only reachable across wallets: the same key on the same wallet is serialised by its lock and
  // found by the lookup. Across wallets the payloads differ (the wallet id is hashed): a conflict.
  wager_transactions_idempotency_key_key: () => new IdempotencyKeyConflictError(),
  wager_transactions_provider_external_key: () => new ExternalTransactionConflictError(),
};

function translate(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const { constraint } = error as { constraint?: string };
    const conflict = constraint === undefined ? undefined : CONFLICTS[constraint];
    if (conflict !== undefined) return conflict();
  }
  return error;
}

/**
 * Each `run` forks its own `EntityManager` (ADR-13) and opens one transaction at the server's
 * default `READ COMMITTED`. Every write reaches the database before it returns: the records have
 * no ORM relations, so the call order is the foreign-key order. A throw anywhere in `work` rolls
 * every write back.
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(this.scope(em)));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Writes are native (`em.insert`, `em.nativeUpdate`): one statement on the transaction's
   * connection, sent before the call returns. Reads skip the identity map. Nothing is tracked, so
   * there is no change set to flush later.
   */
  private scope(em: EntityManager): TransactionScope {
    return {
      wallets: {
        insert: async (wallet) => {
          await em.insert(WalletRecord, toWalletRecord(wallet));
        },
        lock: async (walletId) => {
          const row = await em.findOne(WalletRecord, walletId, {
            lockMode: LockMode.PESSIMISTIC_WRITE,
            disableIdentityMap: true,
          });
          return row === null ? undefined : toWallet(row);
        },
        update: async (wallet, expectedVersion) => {
          const { balance, version, updatedAt } = toWalletRecord(wallet);
          const updated = await em.nativeUpdate(
            WalletRecord,
            { id: wallet.id, version: expectedVersion },
            { balance, version, updatedAt },
          );
          // Under the lock the version always matches; a miss is a bug, never a lost update.
          if (updated !== 1) throw new Error(`stale wallet version: ${wallet.id}`);
        },
      },
      transactions: {
        insert: async (transaction) => {
          await em.insert(WagerTransactionRecord, toWagerTransactionRecord(transaction));
        },
        findByIdentity: async ({ idempotencyKey, providerId, externalTransactionId }) => {
          const rows = await em.find(
            WagerTransactionRecord,
            { $or: [{ idempotencyKey }, { providerId, externalTransactionId }] },
            { disableIdentityMap: true },
          );
          return rows.map(toWagerTransaction);
        },
      },
      ledger: {
        append: async (entry, counterparty) => {
          const accountId = await this.accountId(
            em,
            counterparty,
            entry.money.currency,
            entry.createdAt,
          );
          await em.insert(LedgerEntryRecord, toLedgerEntryRecord(entry, accountId));
        },
      },
      outbox: {
        enqueue: async (events) => {
          if (events.length === 0) return;
          await em.insertMany(OutboxMessageRecord, events.map(toOutboxMessageRecord));
        },
      },
    };
  }

  /**
   * The system account row, created on first use (ADR-12). The common case is one select. When
   * the account is missing, `ON CONFLICT DO NOTHING` makes a concurrent creator wait on the unique
   * index until the other transaction ends; the second select is a new statement, so at
   * `READ COMMITTED` it sees the row that won. The account row is never locked for update.
   */
  private async accountId(
    em: EntityManager,
    counterparty: LedgerCounterparty,
    currency: string,
    at: Date,
  ): Promise<string> {
    const providerId =
      counterparty.kind === LedgerAccountKind.ProviderSettlement ? counterparty.providerId : null;
    const find = async () => {
      const rows = await em.execute<{ id: string }[]>(
        `select id from ledger_accounts
          where kind = ? and provider_id is not distinct from ? and currency = ?`,
        [counterparty.kind, providerId, currency],
      );
      return rows[0]?.id;
    };

    const existing = await find();
    if (existing !== undefined) return existing;

    await em.execute(
      `insert into ledger_accounts (id, kind, provider_id, currency, created_at)
       values (?, ?, ?, ?, ?) on conflict do nothing`,
      [this.ids.newId(), counterparty.kind, providerId, currency, at],
    );
    const created = await find();
    if (created === undefined) {
      throw new Error(`System account ${counterparty.kind} ${currency} was not created`);
    }
    return created;
  }
}
