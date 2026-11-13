import type { IntegrationEvent } from '../domain/events/integration-event';
import type { LedgerCounterparty } from '../domain/ledger-account';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/** Time comes from here, never from `new Date()` in a use case. */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}

/** The two identities of a transaction (ADR-03, L-04); each is unique on its own. */
export interface TransactionIdentity {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
}

/**
 * The reads and writes available inside one SQL transaction. Each call reaches the database before it
 * returns, in the order it is called, so a constraint violation surfaces at the write that caused it.
 */
export interface TransactionScope {
  wallets: {
    insert(wallet: Wallet): Promise<void>;
    /**
     * `SELECT … FOR UPDATE` (ADR-01): the wallet stays locked until the transaction ends, and a
     * concurrent lock waits. Undefined when the wallet does not exist.
     */
    lock(walletId: string): Promise<Wallet | undefined>;
    /** Writes balance, version and update time; throws when the stored version is not `expectedVersion`. */
    update(wallet: Wallet, expectedVersion: number): Promise<void>;
  };
  transactions: {
    insert(transaction: WagerTransaction): Promise<void>;
    /** Every transaction holding this idempotency key or this provider and external id (at most two). */
    findByIdentity(identity: TransactionIdentity): Promise<WagerTransaction[]>;
    /** The transaction a reference names (statement §7.1), on any wallet; the caller checks it. */
    findByExternalId(
      providerId: string,
      externalTransactionId: string,
    ): Promise<WagerTransaction | undefined>;
    /** Whether a `PROCESSED` `REFUND` or `ROLLBACK` of this transaction exists (L-01). */
    hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  };
  ledger: {
    /** Posts `entry` against the system account `counterparty` names in the entry's currency (ADR-12). */
    append(entry: WalletLedgerEntry, counterparty: LedgerCounterparty): Promise<void>;
  };
  outbox: {
    enqueue(events: readonly IntegrationEvent<object>[]): Promise<void>;
  };
}

/**
 * One SQL transaction (statement §11, invariant 6): everything `work` writes commits together, or
 * nothing does when it throws. Nothing is published from inside it.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

/** Reads outside any transaction: a committed snapshot, no lock. */
export interface WalletQueries {
  findById(walletId: string): Promise<Wallet | undefined>;
}
