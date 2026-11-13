import { InsufficientFundsError, MoneyOutOfRangeError } from '../domain/errors';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { FailureCode } from '../domain/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { TransactionScope } from './ports';

export interface Settlement {
  /** The movement; undefined when nothing moved. */
  entry: WalletLedgerEntry | undefined;
  /** The reference is missing or itself waiting (L-10): the transaction's status is unchanged. */
  waiting: boolean;
}

/**
 * ARCHITECTURE §2 steps 7 to 9, shared by the request path and the pending-reference worker: settles
 * `transaction` against its locked `wallet`, `PROCESSED` with the movement or `REJECTED` with the
 * wallet untouched (statement §7.6), unless the reference is not there yet. Each caller decides
 * what waiting means: a new row waits, a retried one counts an attempt.
 */
export async function settle(
  scope: TransactionScope,
  transaction: WagerTransaction,
  wallet: Wallet,
  entryId: string,
  at: Date,
): Promise<Settlement> {
  const nothing = { entry: undefined, waiting: false };
  if (wallet.playerId !== transaction.playerId) {
    transaction.reject(FailureCode.WalletPlayerMismatch, wallet.balance);
    return nothing;
  }
  if (wallet.currency !== transaction.money.currency) {
    transaction.reject(FailureCode.CurrencyMismatch, wallet.balance);
    return nothing;
  }

  // Step 8. A reference of this wallet is covered by its lock, and so is the lookup of an earlier
  // reversal: two reversals of one BET are serialised (L-01). A reference of another wallet is
  // only read, and ends in REFERENCE_MISMATCH.
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
      return nothing;
    }
    // Missing, or itself waiting (L-10).
    if (reference?.status !== WagerTransactionStatus.Processed) {
      return { entry: undefined, waiting: true };
    }
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, wallet.balance, at);
    return nothing;
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
    return nothing;
  }
  transaction.markProcessed(reference?.id, wallet.balance, at);
  return { entry, waiting: false };
}

/** The outbox rows for the status `transaction` reached (statement §11), each with a fresh context. */
export function settlementEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  context: () => EventContext,
): IntegrationEvent<object>[] {
  const events: IntegrationEvent<object>[] = [];
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(transaction, wallet, context()));
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, wallet, context()));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(transaction, wallet, context()));
      break;
    default:
      throw new Error(`no event for a ${transaction.status} transaction`);
  }
  if (entry !== undefined) events.push(WalletBalanceChanged.from(wallet, entry, context()));
  return events;
}
