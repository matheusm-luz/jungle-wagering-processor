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
import type { Clock, IdGenerator, TransactionScope, UnitOfWork } from './ports';

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
  /** Required for `REFUND` and `ROLLBACK`, optional for `WIN` and `LOSS` (L-18). Hashed. */
  referenceExternalTransactionId?: string | undefined;
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
      const entry = await this.apply(scope, transaction, wallet, entryId, at);
      const events: IntegrationEvent<object>[] = [];
      if (transaction.status === WagerTransactionStatus.Rejected) {
        events.push(WagerTransactionRejected.from(transaction, wallet, context()));
      } else if (transaction.status === WagerTransactionStatus.Processed) {
        events.push(WagerTransactionProcessed.from(transaction, wallet, context()));
      }
      // shortcut: PENDING_REFERENCE emits nothing yet; WagerTransactionPendingReference is S7.
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
   * Settles the transaction against the locked wallet: `PROCESSED` with the movement, `REJECTED`
   * with the wallet untouched (statement §7.6), or `PENDING_REFERENCE` when the reference is not
   * there yet. The entry is undefined when nothing moved.
   */
  private async apply(
    scope: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    entryId: string,
    at: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    if (wallet.playerId !== transaction.playerId) {
      transaction.reject(FailureCode.WalletPlayerMismatch, wallet.balance);
      return undefined;
    }
    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, wallet.balance);
      return undefined;
    }

    // ARCHITECTURE §2 step 8. A reference of this wallet is covered by its lock, and so is the
    // lookup of an earlier reversal: two reversals of one BET are serialised (L-01). A reference of
    // another wallet is only read, and ends in REFERENCE_MISMATCH.
    const declared = transaction.referenceExternalTransactionId;
    const reference =
      declared === undefined
        ? undefined
        : await scope.transactions.findByExternalId(transaction.providerId, declared);
    if (declared !== undefined) {
      const failure =
        reference === undefined
          ? undefined
          : transaction.referenceFailure(
              reference,
              transaction.requiresReference() &&
                (await scope.transactions.hasProcessedReversal(reference.id)),
            );
      if (failure !== undefined) {
        transaction.reject(failure, wallet.balance);
        return undefined;
      }
      // Missing, or itself waiting (L-10): wait for it (docs/tasks/S6.md, Q1).
      if (reference?.status !== WagerTransactionStatus.Processed) {
        transaction.markPendingReference(wallet.balance);
        return undefined;
      }
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, wallet.balance, at);
      return undefined;
    }

    const movement = { entryId, transactionId: transaction.id, money: transaction.money, at };
    let entry: WalletLedgerEntry;
    try {
      entry =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    } catch (error) {
      // Both leave the wallet unchanged (Wallet.apply checks before it assigns).
      const code =
        error instanceof InsufficientFundsError
          ? transaction.requiresReference()
            ? FailureCode.ReversalWouldOverdraw
            : FailureCode.InsufficientFunds
          : error instanceof MoneyOutOfRangeError
            ? FailureCode.BalanceLimitExceeded
            : undefined;
      if (code === undefined) throw error;
      transaction.reject(code, wallet.balance);
      return undefined;
    }
    transaction.markProcessed(reference?.id, wallet.balance, at);
    return entry;
  }
}
