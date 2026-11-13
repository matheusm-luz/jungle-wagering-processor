import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { WalletAlreadyExistsError } from '../../application/errors';
import type { IdGenerator, TransactionScope, UnitOfWork } from '../../application/ports';
import { ID_GENERATOR } from '../../application/tokens';
import { LedgerAccountKind, type LedgerCounterparty } from '../../domain/ledger-account';
import {
  toLedgerEntryRecord,
  toOutboxMessageRecord,
  toWagerTransactionRecord,
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
 * default `READ COMMITTED`. Every write flushes before it returns: the records have no ORM
 * relations, so the call order is the foreign-key order and nothing waits for a final flush.
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

  private scope(em: EntityManager): TransactionScope {
    const write = async (entity: object) => {
      em.persist(entity);
      await em.flush();
    };

    return {
      wallets: {
        insert: (wallet) => write(em.create(WalletRecord, toWalletRecord(wallet))),
      },
      transactions: {
        insert: (transaction) =>
          write(em.create(WagerTransactionRecord, toWagerTransactionRecord(transaction))),
      },
      ledger: {
        append: async (entry, counterparty) => {
          const accountId = await this.accountId(
            em,
            counterparty,
            entry.money.currency,
            entry.createdAt,
          );
          await write(em.create(LedgerEntryRecord, toLedgerEntryRecord(entry, accountId)));
        },
      },
      outbox: {
        enqueue: async (events) => {
          for (const event of events) {
            em.persist(em.create(OutboxMessageRecord, toOutboxMessageRecord(event)));
          }
          await em.flush();
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
