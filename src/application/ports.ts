import type { IntegrationEvent } from '../domain/events/integration-event';
import type { LedgerCounterparty } from '../domain/ledger-account';
import type { Money } from '../domain/money';
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

/** A waiting transaction found by the worker's scan, with the identifiers its log lines carry. */
export interface DuePending {
  id: string;
  walletId: string;
  providerId: string;
  /** Undefined for a row written before the correlation id was stored (L-15). */
  correlationId: string | undefined;
}

/** A transaction waiting for its reference, with the worker's bookkeeping (ADR-05). */
export interface PendingTransaction {
  transaction: WagerTransaction;
  /** Worker attempts made so far; the request's own lookup is not one (S7, Q2). */
  attempts: number;
  nextAttemptAt: Date;
  /** The creating request's id (L-15); undefined for a row written before it was stored. */
  correlationId: string | undefined;
}

/** One queue message as the inbox keys it (statement §10: `(consumerName, messageId)`). */
export interface InboxRecord {
  consumerName: string;
  messageId: string;
  /** The transaction's payload hash (ADR-03): the same id with another payload is a conflict. */
  payloadHash: string;
  at: Date;
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
    /** `correlationId` is the creating request's, kept for the events of a later retry (L-15). */
    insert(transaction: WagerTransaction, correlationId: string): Promise<void>;
    /** Every transaction holding this idempotency key or this provider and external id (at most two). */
    findByIdentity(identity: TransactionIdentity): Promise<WagerTransaction[]>;
    /** The transaction a reference names (statement §7.1), on any wallet; the caller checks it. */
    findByExternalId(
      providerId: string,
      externalTransactionId: string,
    ): Promise<WagerTransaction | undefined>;
    /** Whether a `PROCESSED` `REFUND` or `ROLLBACK` of this transaction exists (L-01). */
    hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
    /** Waiting transactions due at `now`, oldest due first. A plain read: nothing is locked. */
    findDuePending(now: Date, limit: number): Promise<DuePending[]>;
    /** The transaction if it is still `PENDING_REFERENCE`; under its wallet's lock this is the re-check. */
    loadPending(id: string): Promise<PendingTransaction | undefined>;
    /** Records a failed attempt. Throws when the row is no longer waiting. */
    reschedule(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
    /** Writes the terminal state a waiting transaction reached. Throws when it is no longer waiting. */
    finish(transaction: WagerTransaction, attempts: number): Promise<void>;
  };
  ledger: {
    /** Posts `entry` against the system account `counterparty` names in the entry's currency (ADR-12). */
    append(entry: WalletLedgerEntry, counterparty: LedgerCounterparty): Promise<void>;
  };
  outbox: {
    enqueue(events: readonly IntegrationEvent<object>[]): Promise<void>;
  };
  inbox: {
    /**
     * Inserts the message. A second record of the same message waits until the first transaction
     * ends, then answers `duplicate` (same hash) or `conflict` (another hash).
     */
    record(message: InboxRecord): Promise<'new' | 'duplicate' | 'conflict'>;
  };
}

/**
 * One SQL transaction (statement §11, invariant 6): everything `work` writes commits together, or
 * nothing does when it throws. Nothing is published from inside it.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

/** A wallet's stored balance next to its ledger sums, read in one snapshot (R-49). */
export interface ReconciliationInput {
  walletId: string;
  stored: Money;
  credits: Money;
  debits: Money;
  entries: number;
}

/** Reads outside any transaction: a committed snapshot, no lock. */
export interface WalletQueries {
  findById(walletId: string): Promise<Wallet | undefined>;
  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /**
   * Up to `limit` entries with a sequence above `afterSequence`, ascending; undefined when the
   * wallet does not exist.
   */
  ledgerPage(
    walletId: string,
    afterSequence: number,
    limit: number,
  ): Promise<WalletLedgerEntry[] | undefined>;
  /**
   * The stored balance and the ledger sums from one statement, so from one snapshot: two reads
   * could see a commit in between and report a divergence that does not exist.
   */
  reconciliationInput(walletId: string): Promise<ReconciliationInput | undefined>;
}
