import type { EventContext } from '../domain/events/integration-event';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { Clock, DuePending, IdGenerator, UnitOfWork } from './ports';
import { delayBeforeNextAttempt, type ReferenceRetryPolicy } from './reference-retry-policy';
import { settle, settlementEvents } from './settlement';

/** The row and its wallet: all a retry needs to take the locks in order. */
type WalletRow = Pick<DuePending, 'id' | 'walletId'>;

/** What one retry did; `skipped` when another worker got there first. */
export type RetryOutcome = 'skipped' | 'rescheduled' | WagerTransactionStatus;

/**
 * The pending-reference worker's use case (ADR-05). Every instance runs it; PostgreSQL is the only
 * coordination: the scan locks nothing, and each retry locks the wallet and re-reads the row under
 * that lock, so a row another worker already moved is skipped, never applied twice.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: ReferenceRetryPolicy,
  ) {}

  /** The rows due now, oldest first. A plain read, in a transaction of its own. */
  findDue(limit: number): Promise<DuePending[]> {
    const now = this.clock.now();
    return this.unitOfWork.run((scope) => scope.transactions.findDuePending(now, limit));
  }

  /** One attempt at one row, in one SQL transaction: its new state, entry, wallet and events. */
  retry({ id, walletId }: WalletRow): Promise<RetryOutcome> {
    return this.unitOfWork.run(async (scope) => {
      // Lock order of the request path: the wallet first, then rows of that wallet.
      const wallet = await scope.wallets.lock(walletId);
      const pending = wallet === undefined ? undefined : await scope.transactions.loadPending(id);
      const at = this.clock.now();
      // The re-check: settled or rescheduled by another worker since the scan.
      if (wallet === undefined || pending === undefined || pending.nextAttemptAt > at) {
        return 'skipped';
      }

      const { transaction } = pending;
      const attempts = pending.attempts + 1;
      const lockedVersion = wallet.version;
      const { entry, waiting } = await settle(scope, transaction, wallet, this.ids.newId(), at);
      if (waiting) {
        const delay = delayBeforeNextAttempt(this.policy, attempts);
        if (delay !== undefined) {
          await scope.transactions.reschedule(id, attempts, new Date(at.getTime() + delay));
          return 'rescheduled';
        }
        transaction.reject(FailureCode.ReferenceNotFound, wallet.balance);
      }

      // The request's id (L-15); a row written before it was stored gets a new one.
      const correlationId = pending.correlationId ?? this.ids.newId();
      const context = (): EventContext => ({
        eventId: this.ids.newId(),
        correlationId,
        occurredAt: at,
      });
      const events = settlementEvents(transaction, wallet, entry, context);

      await scope.transactions.finish(transaction, attempts);
      if (entry !== undefined) {
        await scope.ledger.append(entry, transaction.counterparty());
        await scope.wallets.update(wallet, lockedVersion);
      }
      await scope.outbox.enqueue(events);
      return transaction.status;
    });
  }

  /**
   * Pushes a row whose retry failed unexpectedly by the maximum delay, so it leaves the head of the
   * queue instead of blocking every worker (S7 review, M1). Under the wallet lock, like a retry; a
   * row that is no longer waiting is left alone. A transient failure (the database or a lock) never
   * counts an attempt, so an outage cannot fail a transaction. A non-transient one counts
   * (`countsAttempt`), and the attempt that exhausts the policy makes the row `FAILED` with
   * `PROCESSING_FAILED` and its event (docs/tasks/S12.md, Q2).
   */
  postpone(
    { id, walletId }: WalletRow,
    { countsAttempt = false }: { countsAttempt?: boolean } = {},
  ): Promise<'skipped' | 'postponed' | 'FAILED'> {
    return this.unitOfWork.run(async (scope) => {
      const wallet = await scope.wallets.lock(walletId);
      const pending = wallet === undefined ? undefined : await scope.transactions.loadPending(id);
      if (wallet === undefined || pending === undefined) return 'skipped';
      const at = this.clock.now();
      const attempts = pending.attempts + (countsAttempt ? 1 : 0);
      if (!countsAttempt || attempts < this.policy.maxAttempts) {
        await scope.transactions.reschedule(
          id,
          attempts,
          new Date(at.getTime() + this.policy.maxDelayMs),
        );
        return 'postponed';
      }

      const { transaction } = pending;
      transaction.fail(FailureCode.ProcessingFailed);
      const correlationId = pending.correlationId ?? this.ids.newId();
      const events = settlementEvents(transaction, wallet, undefined, () => ({
        eventId: this.ids.newId(),
        correlationId,
        occurredAt: at,
      }));
      await scope.transactions.finish(transaction, attempts);
      await scope.outbox.enqueue(events);
      return WagerTransactionStatus.Failed;
    });
  }
}
