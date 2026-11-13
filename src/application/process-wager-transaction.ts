import {
  InsufficientFundsError,
  InvalidTransactionError,
  MoneyOutOfRangeError,
} from '../domain/errors';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { FailureCode } from '../domain/failure-code';
import type { Money } from '../domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
} from './errors';
import { payloadHash } from './payload-hash';
import type { Clock, IdGenerator, UnitOfWork } from './ports';

export interface ProcessWagerTransactionCommand {
  /** The `Idempotency-Key` header, or `data.idempotencyKey` on SQS. Not part of the hash. */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  correlationId: string;
}

export interface WagerTransactionResult {
  /** Terminal or pending; its status, failure code and observed balance are the answer. */
  transaction: WagerTransaction;
  /** True when the answer is the stored result of an earlier request with the same key. */
  idempotentReplay: boolean;
}

/**
 * The critical section of ARCHITECTURE §2, shared by HTTP and SQS. Everything that does not need
 * the database happens before the transaction opens; inside it the wallet lock comes first, so
 * every read after it sees what the previous holder committed.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const receivedAt = this.clock.now();
    const { idempotencyKey, correlationId, ...fields } = command;
    const transaction = this.create({
      ...fields,
      id: this.ids.newId(),
      idempotencyKey,
      payloadHash: payloadHash(fields),
      createdAt: receivedAt,
    });
    const entryId = this.ids.newId();

    return this.unitOfWork.run(async (scope) => {
      const wallet = await scope.wallets.lock(transaction.walletId);
      if (wallet === undefined) throw new WalletNotFoundError();

      // Under the lock: a request for this wallet that committed before is visible now (ADR-01).
      const known = await scope.transactions.findByIdentity(transaction);
      const sameKey = known.find((stored) => stored.idempotencyKey === idempotencyKey);
      if (sameKey !== undefined) {
        if (!sameKey.matchesPayload(transaction.payloadHash))
          throw new IdempotencyKeyConflictError();
        return { transaction: sameKey, idempotentReplay: true };
      }
      if (known.length > 0) throw new ExternalTransactionConflictError();

      // Read after the lock: a request that waited must not stamp its movement and events earlier
      // than the holder it waited for, or times would run against the wallet version (S4 review, m1).
      const at = this.clock.now();
      const context = (): EventContext => ({
        eventId: this.ids.newId(),
        correlationId,
        occurredAt: at,
      });

      const lockedVersion = wallet.version;
      const entry = this.apply(transaction, wallet, entryId, at);
      const events: IntegrationEvent<object>[] = [];
      if (transaction.status === WagerTransactionStatus.Rejected) {
        events.push(WagerTransactionRejected.from(transaction, wallet, context()));
      } else {
        events.push(WagerTransactionProcessed.from(transaction, wallet, context()));
      }
      if (entry !== undefined) {
        events.push(WalletBalanceChanged.from(wallet, entry, context()));
      }

      // Foreign-key order: the transaction before its entry; the outbox rows last.
      await scope.transactions.insert(transaction);
      if (entry !== undefined) {
        await scope.ledger.append(entry, transaction.counterparty());
        await scope.wallets.update(wallet, lockedVersion);
      }
      await scope.outbox.enqueue(events);
      return { transaction, idempotentReplay: false };
    });
  }

  /** The rules `WagerTransaction.create` enforces alone are request errors (L-03, L-18): 400. */
  private create(props: Parameters<typeof WagerTransaction.create>[0]): WagerTransaction {
    try {
      return WagerTransaction.create(props);
    } catch (error) {
      if (error instanceof InvalidTransactionError) {
        throw new InvalidWagerTransactionError(error.message);
      }
      throw error;
    }
  }

  /**
   * Settles the transaction against the locked wallet: `PROCESSED` with the movement, or
   * `REJECTED` with the wallet untouched (statement §7.6). The entry is undefined when nothing moved.
   */
  private apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    entryId: string,
    at: Date,
  ): WalletLedgerEntry | undefined {
    if (wallet.playerId !== transaction.playerId) {
      transaction.reject(FailureCode.WalletPlayerMismatch, wallet.balance);
      return undefined;
    }
    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, wallet.balance);
      return undefined;
    }
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(undefined, wallet.balance, at);
      return undefined;
    }

    const movement = { entryId, transactionId: transaction.id, money: transaction.money, at };
    let entry: WalletLedgerEntry;
    try {
      entry =
        transaction.ledgerDirectionFor() === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    } catch (error) {
      // Both leave the wallet unchanged (Wallet.apply checks before it assigns).
      const code =
        error instanceof InsufficientFundsError
          ? FailureCode.InsufficientFunds
          : error instanceof MoneyOutOfRangeError
            ? FailureCode.BalanceLimitExceeded
            : undefined;
      if (code === undefined) throw error;
      transaction.reject(code, wallet.balance);
      return undefined;
    }
    transaction.markProcessed(undefined, wallet.balance, at);
    return entry;
  }
}
